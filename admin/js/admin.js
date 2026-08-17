/* ═══════════════════════════════════════════════
   SV CAPITAL — Admin Dashboard JS
   ═══════════════════════════════════════════════ */
'use strict';

/* Escape user-controlled strings before inserting into innerHTML */
const _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/* Cache for ticket document data — avoids embedding large base64 in onclick attributes */
const _ticketDocCache = {};

/* ─── State ─── */
let _gChordPending = false;

let STATE = {
  investors: [],
  subAccounts: [],
  pools: [],
  investments: [],
  transactions: [],
  kyc: [],
  tickets: [],
  maturity: [],
  settings: [],
  ifas: [],
  withdrawals: [],
  amlFlags: [],
  adminEmail: null,
  currentView: 'dashboard',
  charts: {},
  lastRefreshed: {},
  filters: {}
};

/* ─── Button loading helper ─── */
async function _withBtn(btn, asyncFn) {
  if (!btn || btn.disabled) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  try { return await asyncFn(); }
  finally { btn.disabled = false; btn.innerHTML = orig; }
}

/* ─── Custom confirm dialog (replaces browser confirm()) ─── */
const Confirm = {
  ask(title, { body = '', confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      document.getElementById('confirmModalTitle').textContent = title;
      document.getElementById('confirmModalBody').textContent = body;
      const okBtn = document.getElementById('confirmModalOk');
      const cancelBtn = document.getElementById('confirmModalCancel');
      okBtn.textContent = confirmLabel;
      okBtn.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;

      const overlay = document.getElementById('confirmModal');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';

      const cleanup = (result) => {
        overlay.classList.remove('open');
        document.body.style.overflow = '';
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        resolve(result);
      };

      // Re-query after clone
      document.getElementById('confirmModalOk').addEventListener('click', () => cleanup(true), { once: true });
      document.getElementById('confirmModalCancel').addEventListener('click', () => cleanup(false), { once: true });
    });
  }
};

/* ─── Copy to clipboard ─── */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(String(text));
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check" style="color:var(--green)"></i>';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch (_) { Toast.info('Press Ctrl+C to copy'); }
}

/* ─── Last-refreshed tracker ─── */
function _markRefreshed(view) { STATE.lastRefreshed[view] = Date.now(); }
function _refreshedText(view) {
  const t = STATE.lastRefreshed[view];
  if (!t) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}
function _setRefreshLabel(elId, view) {
  const el = document.getElementById(elId);
  if (el) el.textContent = `Updated ${_refreshedText(view)}`;
}

/* ─── Get current admin's full name (for audit/review fields) ─── */
function _getAdminName() {
  try {
    const s = JSON.parse(localStorage.getItem('staffSession') || 'null');
    if (s && s.empId && s.expiresAt > Date.now()) {
      return `${s.firstName || ''} ${s.lastName || ''}`.trim() || 'Admin';
    }
  } catch (_) {}
  if (typeof Auth !== 'undefined') {
    const u = Auth.getUser();
    if (u) return `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Admin';
  }
  return 'Admin';
}

/* ─── Empty-state row helper ─── */
function _emptyRow(icon, title, sub, colspan = 6) {
  return `<tr><td colspan="${colspan}" style="padding:0;border:none">
    <div class="empty-state">
      <i class="fa-solid ${icon}"></i>
      <div class="empty-state__title">${title}</div>
      <div class="empty-state__sub">${sub}</div>
    </div>
  </td></tr>`;
}

/* ─── Table density toggle ─── */
function toggleTableDensity(wrapperId, btnId) {
  const wrapper = document.getElementById(wrapperId);
  const btn     = document.getElementById(btnId);
  if (!wrapper) return;
  const card = wrapper.closest('.table-card') || wrapper;
  card.classList.toggle('compact');
  if (btn) btn.classList.toggle('on', card.classList.contains('compact'));
}

/* ─── Inline form field validation ─── */
function _setupFieldValidation(inputId, validateFn, hintId) {
  const input = document.getElementById(inputId);
  const hint  = hintId ? document.getElementById(hintId) : null;
  if (!input) return;
  input.addEventListener('input', () => {
    const result = validateFn(input.value);
    input.classList.toggle('input--error', result === false);
    input.classList.toggle('input--ok', result === true);
    if (hint) {
      hint.textContent = typeof result === 'string' ? result : '';
      hint.className = `field-hint ${result === false ? 'field-hint--error' : result === true ? 'field-hint--ok' : ''}`;
    }
  });
}

/* ─── Admin Welcome Strip ─── */
function _adminGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function _populateAdminWelcomeStrip(identity, pendingKyc, openTickets) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };

  set('adminWelcomeGreeting', _adminGreeting());
  set('adminWelcomeName', identity.name || 'Admin Console');

  const roleLabelMap = { director: 'Director', admin: 'Administrator', staff: 'Staff', fund_manager: 'Fund Manager' };
  set('adminChipRole', roleLabelMap[identity.role] || identity.role || 'Administrator');

  if (pendingKyc > 0) {
    set('adminChipKycVal', pendingKyc);
    show('adminChipKyc');
  }
  if (openTickets > 0) {
    set('adminChipTicketsVal', openTickets);
    show('adminChipTickets');
  }
}

/* ─── Admin Notifications ─── */
function toggleAdminNotif() {
  const panel = document.getElementById('adminNotifPanel');
  const btn   = document.getElementById('adminNotifBtn');
  if (!panel) return;

  const isOpen = panel.classList.contains('notif-panel--open');
  if (isOpen) {
    panel.classList.remove('notif-panel--open');
    panel.style.display = 'none';
  } else {
    panel.style.display = 'block';
    panel.offsetHeight; // force reflow
    panel.classList.add('notif-panel--open');
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

function _syncAdminNotifDot() {
  const dot    = document.getElementById('adminNotifDot');
  const unread = document.querySelectorAll('#adminNotifPanel .notif-item.unread').length;
  if (dot) {
    dot.classList.toggle('has-unread', unread > 0);
    dot.textContent = unread > 0 ? (unread > 9 ? '9+' : unread) : '';
  }
}

const _ADMIN_NOTIF_READ_KEY = 'svc_admin_dismissed_notifs';
function _getAdminReadNotifs() {
  try { return new Set(JSON.parse(localStorage.getItem(_ADMIN_NOTIF_READ_KEY) || '[]')); } catch(_) { return new Set(); }
}
function _saveAdminReadNotifs(s) {
  try { localStorage.setItem(_ADMIN_NOTIF_READ_KEY, JSON.stringify([...s])); } catch(_) {}
}

function adminMarkAllRead() {
  const dismissed = _getAdminReadNotifs();
  document.querySelectorAll('#adminNotifPanel .notif-item[data-nid]').forEach(el => { if (el.dataset.nid) dismissed.add(el.dataset.nid); });
  _saveAdminReadNotifs(dismissed);
  const body = document.getElementById('adminNotifBody');
  if (body) body.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#888;font-size:0.82rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>No pending actions — all clear!</div>';
  const dot = document.getElementById('adminNotifDot');
  if (dot) { dot.classList.remove('has-unread'); dot.textContent = ''; }
}

/* ── Dynamic admin notification panel ─────────────────────────────────────
   Builds real-time alerts from already-loaded STATE data.
   Called at the end of loadDashboard() once investors, transactions
   and tickets are in memory.
─────────────────────────────────────────────────────────────────────────── */
function loadAdminNotifications(investors, transactions, tickets) {
  const body = document.getElementById('adminNotifBody');
  if (!body) return;

  const now    = new Date();
  const notifs = [];
  const _aDismissed = _getAdminReadNotifs();
  const _an = (obj) => { if (obj.nid && _aDismissed.has(obj.nid)) obj.unread = false; return obj; };

  // 1. Pending KYC / FICA
  const pendingKyc = investors.filter(i =>
    i.kyc_status === 'pending' || i.fica_status === 'pending' ||
    i.status === 'pending_fica' || i.status === 'fica_submitted'
  );
  if (pendingKyc.length) {
    notifs.push(_an({
      nid: `kyc-${pendingKyc.map(i=>i.id).sort().join('-')}`,
      icon: 'fa-user-clock', iconBg: 'rgba(239,68,68,0.1)', iconColor: '#ef4444',
      title: `${pendingKyc.length} KYC ${pendingKyc.length === 1 ? 'application' : 'applications'} pending`,
      sub: `${pendingKyc.slice(0,2).map(i => _esc(i.first_name)).join(', ')}${pendingKyc.length > 2 ? ` +${pendingKyc.length - 2} more` : ''} awaiting FICA review.`,
      action: "navigate('kyc',document.querySelector('[data-view=kyc]'));toggleAdminNotif()",
      unread: true,
    }));
  }

  // 2. Bank accounts awaiting verification
  const pendingBank = investors.filter(i => i.bank_account_status === 'pending');
  if (pendingBank.length) {
    notifs.push(_an({
      nid: `bank-${pendingBank.map(i=>i.id).sort().join('-')}`,
      icon: 'fa-building-columns', iconBg: 'rgba(237,165,255,0.1)', iconColor: '#656565',
      title: `${pendingBank.length} bank account${pendingBank.length === 1 ? '' : 's'} to verify`,
      sub: `${pendingBank.slice(0,2).map(i => `${_esc(i.first_name)} ${_esc(i.last_name)}`).join(', ')}${pendingBank.length > 2 ? ` +${pendingBank.length - 2} more` : ''}.`,
      action: "navigate('investors',document.querySelector('[data-view=investors]'));toggleAdminNotif()",
      unread: true,
    }));
  }

  // 3. Pending withdrawals
  const pendingWith = transactions.filter(t => t.type === 'withdrawal' && t.status === 'pending');
  if (pendingWith.length) {
    const total = pendingWith.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
    notifs.push(_an({
      nid: `with-${pendingWith.map(t=>t.id).sort().join('-')}`,
      icon: 'fa-money-bill-transfer', iconBg: 'rgba(239,68,68,0.1)', iconColor: '#ef4444',
      title: `${pendingWith.length} withdrawal${pendingWith.length === 1 ? '' : 's'} pending`,
      sub: `${Utils.rand(total)} total awaiting processing.`,
      action: "navigate('withdrawals',document.querySelector('[data-view=withdrawals]'));toggleAdminNotif()",
      unread: true,
    }));
  }

  // 4. Bank verification support tickets
  const bankTkts = tickets.filter(t => t.category === 'bank_verification' && t.status === 'open');
  if (bankTkts.length) {
    notifs.push(_an({
      nid: `btkt-${bankTkts.map(t=>t.id).sort().join('-')}`,
      icon: 'fa-file-invoice', iconBg: 'rgba(254,194,79,0.12)', iconColor: '#fec24f',
      title: `${bankTkts.length} bank verification ticket${bankTkts.length === 1 ? '' : 's'}`,
      sub: `${bankTkts.slice(0,2).map(t => _esc(t.investor_name || 'Investor')).join(', ')} submitted bank details.`,
      action: "navigate('support',document.querySelector('[data-view=support]'));toggleAdminNotif()",
      unread: true,
    }));
  }

  // 5. Other open support tickets (unanswered)
  const openTkts = tickets.filter(t => t.status === 'open' && t.category !== 'bank_verification' && !t.admin_response);
  if (openTkts.length) {
    const urgent = openTkts.filter(t => t.priority === 'high' || t.priority === 'urgent');
    notifs.push(_an({
      nid: `tkt-${openTkts.map(t=>t.id).sort().join('-')}`,
      icon: 'fa-headset', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#656565',
      title: `${openTkts.length} open ticket${openTkts.length === 1 ? '' : 's'} awaiting reply`,
      sub: urgent.length
        ? `${urgent.length} high-priority — &ldquo;${_esc(urgent[0].subject)}&rdquo;`
        : `&ldquo;${_esc(openTkts[0].subject)}&rdquo;`,
      action: "navigate('support',document.querySelector('[data-view=support]'));toggleAdminNotif()",
      unread: true,
    }));
  }

  // 6. Recent deposits (last 24 h) — informational
  const recentDeps = transactions.filter(t => {
    if (t.type !== 'deposit' || t.status !== 'completed') return false;
    return (now - new Date(t.created_at || t.transaction_date || 0)) < 86400000;
  });
  if (recentDeps.length) {
    const total = recentDeps.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    notifs.push({
      icon: 'fa-wallet', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
      title: `${recentDeps.length} deposit${recentDeps.length === 1 ? '' : 's'} received today`,
      sub: `${Utils.rand(total)} credited in the last 24 hours.`,
      action: "navigate('transactions',document.querySelector('[data-view=transactions]'));toggleAdminNotif()",
      unread: false,
    });
  }

  if (!notifs.length) {
    body.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#888;font-size:0.82rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>No pending actions — all clear!</div>';
    document.getElementById('adminNotifDot')?.classList.remove('has-unread');
    return;
  }

  body.innerHTML = notifs.map(n => `
    <div class="notif-item${n.unread ? ' unread' : ''}" data-nid="${_esc(n.nid || '')}" ${n.action ? `onclick="${n.action}" style="cursor:pointer"` : ''}>
      <div class="notif-icon" style="background:${n.iconBg}"><i class="fa-solid ${n.icon}" style="color:${n.iconColor}"></i></div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-sub">${n.sub}</div>
      </div>
    </div>
  `).join('');

  _syncAdminNotifDot();
}

/* ─── View-level tab system ─── */
const _MERGED_VIEW_MAP = {
  'fica-pipeline': { parent: 'kyc',        pane: 'fica-pipeline' },
  'intlinterest':  { parent: 'investors',   pane: 'intlinterest'  },
  'aml':           { parent: 'support',     pane: 'aml'           },
  'emaillogs':     { parent: 'comms',       pane: 'emaillogs'     },
  'auditlog':      { parent: 'compliance',  pane: 'auditlog'      },
  'accepted-docs': { parent: 'compliance',  pane: 'accepted-docs' },
  'maturities':    { parent: 'compliance',  pane: 'maturities'    },
  'failed-logins': { parent: 'compliance',  pane: 'failed-logins' },
  'privacy':       { parent: 'terms',       pane: 'privacy'       },
  'migrate':       { parent: 'settings',    pane: 'migrate'       },
  'staff':         { parent: 'settings',    pane: 'staff'         },
};

function switchViewTab(parentView, paneId, btn) {
  const container = document.getElementById('view-' + parentView);
  if (!container) return;
  container.querySelectorAll('.vtab-btn').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    const b = container.querySelector(`.vtab-btn[data-pane="${paneId}"]`);
    if (b) b.classList.add('active');
  }
  container.querySelectorAll('.vtab-pane').forEach(p => {
    p.classList.toggle('active', p.dataset.pane === paneId);
  });
  // Lazy-load secondary tab content
  const secondaryLoaders = {
    'fica-pipeline': () => typeof loadFicaPipeline !== 'undefined' && loadFicaPipeline(),
    'intlinterest':  () => typeof loadIntlInterest !== 'undefined' && loadIntlInterest(),
    'aml':           () => typeof loadAML !== 'undefined' && loadAML(),
    'emaillogs':     () => typeof loadEmailLogs !== 'undefined' && loadEmailLogs(),
    'auditlog':      () => typeof loadAuditLog !== 'undefined' && loadAuditLog(),
    'accepted-docs': () => typeof loadAcceptedDocuments !== 'undefined' && loadAcceptedDocuments(),
    'maturities':    () => typeof loadUpcomingMaturities !== 'undefined' && loadUpcomingMaturities(),
    'failed-logins': () => typeof loadFailedLogins !== 'undefined' && loadFailedLogins(),
    'privacy':       () => typeof loadPrivacyEditor !== 'undefined' && loadPrivacyEditor(),
    'migrate':       () => typeof loadMigration !== 'undefined' && loadMigration(),
    'staff':         () => typeof loadStaffPermissions !== 'undefined' && loadStaffPermissions(),
  };
  if (secondaryLoaders[paneId]) secondaryLoaders[paneId]();
}

/* ─── Navigation ─── */
function navigate(view, btnEl) {
  // Redirect merged secondary views to their parent + tab
  if (_MERGED_VIEW_MAP[view]) {
    const { parent, pane } = _MERGED_VIEW_MAP[view];
    const parentBtn = document.querySelector(`[data-view="${parent}"]`);
    navigate(parent, parentBtn);
    setTimeout(() => switchViewTab(parent, pane, null), 50);
    return;
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', investors: 'Investor Management', ifa: 'IFA Management', kyc: 'KYC / FICA',
    products: 'Products', pools: 'Investment Pools', investments: 'Investments', maturity: 'Maturity Instructions',
    transactions: 'Transactions', withdrawals: 'Withdrawals', support: 'Support Tickets', analytics: 'Analytics',
    auditlog: 'Audit Log', settings: 'Settings', comms: 'Broadcast Communications', aml: 'AML Compliance Review',
    terms: 'Legal Documents', privacy: 'Privacy Policy &amp; POPIA Notice', intlinterest: 'International Interest',
    opsconsole: 'Operations Console', feedback: 'Client Feedback', emaillogs: 'Email Logs',
    'fica-pipeline': 'FICA Pipeline',
    handbook: 'Platform Handbook',
  };
  document.getElementById('topbarTitle').textContent = titles[view] || view;
  STATE.currentView = view;
  sessionStorage.setItem('svc_admin_view', view);

  // Lazy-load views
  const loaders = {
    investors: loadInvestors,
    ifa: loadIFAs,
    kyc: loadKYC,
    products: loadProducts,
    pools: loadPools,
    investments: loadInvestments,
    maturity: loadMaturity,
    transactions: loadTransactions,
    support: loadSupport,
    analytics: loadAnalytics,
    settings: loadSettings,
    withdrawals: loadWithdrawals,
    comms: loadComms,
    compliance: loadCompliance,
    reconciliation: loadReconciliation,
    terms: loadTermsEditor,
    opsconsole: loadOpsConsole,
    feedback: () => loadFeedback('pending'),
  };
  if (loaders[view]) loaders[view]();
  // Close mobile sidebar after navigation
  closeSidebar();
}

/* ─── Mobile Sidebar ─── */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('open');
  if (backdrop) backdrop.classList.toggle('visible', open);
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (sidebar) sidebar.classList.remove('open');
  if (backdrop) backdrop.classList.remove('visible');
}

/* ─── Page loading bar ─── */
function _showLoadingBar() {
  const bar = document.getElementById('adminLoadingBar');
  if (!bar) return;
  clearTimeout(bar._t1); clearTimeout(bar._t2);
  bar.style.opacity = '1';
  bar.style.width = '30%';
  bar._t1 = setTimeout(() => { bar.style.width = '65%'; }, 600);
  bar._t2 = setTimeout(() => { bar.style.width = '85%'; }, 1400);
}

function _hideLoadingBar() {
  const bar = document.getElementById('adminLoadingBar');
  if (!bar) return;
  clearTimeout(bar._t1); clearTimeout(bar._t2);
  bar.style.width = '100%';
  setTimeout(() => {
    bar.style.opacity = '0';
    setTimeout(() => { bar.style.width = '0'; bar.style.opacity = '1'; }, 420);
  }, 280);
}

/* ═══════════════════════════════════════════════
   USER IDENTITY — populate sidebar + topbar from session
   ═══════════════════════════════════════════════ */
function _populateAdminIdentity(jwtUser) {
  // Build a merged identity object.
  // staffSession has the richest data (avatar colour, initials, level, department).
  // svc_user / jwtUser fills gaps when only a JWT login was used.
  let identity = {
    initials:   null,
    color:      '#eda5ff',
    name:       null,
    role:       null,
    department: null,
    email:      jwtUser ? jwtUser.email : null,
  };

  // Try staffSession first
  try {
    const raw = localStorage.getItem('staffSession');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.empId && s.expiresAt > Date.now()) {
        identity.initials   = s.avatarInitials || null;
        identity.color      = s.avatarColor    || '#eda5ff';
        identity.name       = `${s.firstName || ''} ${s.lastName || ''}`.trim() || null;
        identity.role       = s.role           || null;
        identity.department = s.department     || null;
        identity.email      = s.email          || identity.email;
      }
    }
  } catch (_) {}

  // Fill any gaps from jwtUser (svc_user bridge or real JWT payload)
  if (jwtUser) {
    if (!identity.name)
      identity.name = `${jwtUser.firstName || ''} ${jwtUser.lastName || ''}`.trim() || jwtUser.email || null;
    if (!identity.role)
      identity.role = jwtUser.role || null;
  }

  // Derive initials from name if not set
  if (!identity.initials && identity.name) {
    const parts = identity.name.trim().split(/\s+/);
    identity.initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : identity.name.slice(0, 2).toUpperCase();
  }

  // Build display role label
  const roleLabelMap = {
    director: 'Director',
    admin:    'Admin',
    ifa:      'IFA Partner',
    staff:    'Staff',
  };
  const roleLabel = roleLabelMap[identity.role] || identity.role || 'Admin';
  const deptLabel = identity.department ? `${identity.department} · ` : '';
  const sidebarRoleText = `${deptLabel}${roleLabel}`;

  // ── Apply to sidebar ──
  const avatarEl = document.getElementById('adminSidebarAvatar');
  const nameEl   = document.getElementById('adminSidebarName');
  const roleEl   = document.getElementById('adminSidebarRole');

  if (avatarEl) {
    avatarEl.textContent       = identity.initials || '??';
    avatarEl.style.background  = identity.color;
    avatarEl.style.color       = '#fff';
  }
  if (nameEl)  nameEl.textContent = identity.name  || identity.email || 'Unknown User';
  if (roleEl)  roleEl.textContent = sidebarRoleText;

  // ── Apply to topbar (legacy element — keep for compatibility) ──
  const topbarNameEl = document.getElementById('adminUserName');
  if (topbarNameEl) topbarNameEl.textContent = identity.name || identity.email || '';
}

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  Toast.init();

  // ─── Require authentication ───
  if (typeof Auth !== 'undefined') {
    // Staff PIN login users have a staffSession; email+password users do not.
    const hasStaffSession = (() => {
      try { const s = JSON.parse(localStorage.getItem('staffSession') || 'null'); return !!(s && s.empId && s.expiresAt > Date.now()); } catch (_) { return false; }
    })();
    const loginPage = hasStaffSession ? '/team/login.html' : '/login.html';

    if (!Auth.isLoggedIn()) {
      window.location.href = loginPage;
      return;
    }
    const user = Auth.getUser();
    if (user && !['admin','director'].includes(user.role)) {
      window.location.href = loginPage;
      return;
    }
    // ── Populate user identity from session ──────────────────────────
    // Prefer staffSession (richer: has avatar colour, initials, department)
    // Fall back to svc_user / JWT payload for main-login users.
    _populateAdminIdentity(user);

    // ── Extract admin email from JWT for use in notes etc ──────────────
    try {
      const token = localStorage.getItem('svc_token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        STATE.adminEmail = payload.email || (user && user.email) || null;
      }
    } catch (_) {}
    if (!STATE.adminEmail && user) STATE.adminEmail = user.email || null;
  }

  await loadDashboard();
  setupGlobalSearch();
  _syncAdminNotifDot();

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const inField = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);

    if (e.key === '/' && !inField) {
      e.preventDefault();
      const gs = document.getElementById('globalSearch');
      if (gs) { gs.focus(); gs.select(); }
    }

    // Arrow-key + J/K table row navigation
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') && !inField) {
      const row = document.activeElement.closest('tr[tabindex]');
      if (!row) return;
      e.preventDefault();
      const rows = [...row.closest('tbody').querySelectorAll('tr[tabindex="0"]')];
      const idx  = rows.indexOf(row);
      const next = (e.key === 'ArrowDown' || e.key === 'j') ? rows[idx + 1] : rows[idx - 1];
      if (next) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    }

    // ? = keyboard shortcuts help overlay
    if (e.key === '?' && !inField) {
      e.preventDefault();
      Modal.open('kbShortcutsModal');
    }

    // g+letter navigation chords
    if (e.key === 'g' && !inField && !(e.ctrlKey || e.metaKey || e.altKey)) {
      _gChordPending = true;
      setTimeout(() => { _gChordPending = false; }, 1500);
      return;
    }
    if (_gChordPending && !inField) {
      const NAV_MAP = { d: 'dashboard', i: 'investors', t: 'transactions', k: 'kyc', m: 'maturity' };
      const view = NAV_MAP[e.key];
      if (view) {
        e.preventDefault();
        _gChordPending = false;
        const btn = document.querySelector(`[data-view="${view}"]`);
        if (btn) navigate(view, btn);
      }
    }

    // r = refresh current view
    if (e.key === 'r' && !inField && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      const REFRESH_FNS = {
        dashboard: () => loadDashboard(),
        investors: () => loadInvestors(),
        transactions: () => loadTransactions(),
        kyc: () => loadKyc(),
        maturity: () => loadMaturityInstructions(),
        pools: () => loadPools(),
        investments: () => loadInvestments(),
        withdrawals: () => loadWithdrawals(),
      };
      const fn = REFRESH_FNS[STATE.currentView];
      if (fn) { fn(); Toast.info('Refreshing…', 1500); }
    }

    // Escape closes open modals
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-overlay[style*="flex"], .modal-overlay.open');
      if (open) { const id = open.id; if (id) Modal.close(id); }
    }
  });

  _initSSE();

  // Restore last active view from session (deep-link fix)
  const savedView = sessionStorage.getItem('svc_admin_view');
  if (savedView && savedView !== 'dashboard') {
    const btn = document.querySelector(`[data-view="${savedView}"]`);
    if (btn) navigate(savedView, btn);
  }
});

/* ═══════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadDashboard() {
  _showLoadingBar();
  try {
    const [invRes, poolRes, invstRes, txnRes] = await Promise.all([
      API.investors.list({ limit: 10000 }),
      API.pools.list({ limit: 1000 }),
      API.investments.list({ limit: 5000 }),
      API.transactions.list({ limit: 5000 })
    ]);

    STATE.investors = invRes.data || [];
    STATE.pools = poolRes.data || [];
    STATE.investments = invstRes.data || [];
    STATE.transactions = txnRes.data || [];

    // KPI cards — compute from live tables, not denormalized investor fields
    const totalInvested = STATE.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    const totalReturns  = STATE.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    const activePools = STATE.pools.filter(p => ['open', 'active', 'filling'].includes(p.status)).length;
    const nonArchived = STATE.investors.filter(i => i.status !== 'archived');

    document.getElementById('ds-investors').textContent = STATE.investors.length;
    document.getElementById('ds-invested').textContent = Utils.rand(totalInvested);
    document.getElementById('ds-returns').textContent = Utils.rand(totalReturns);
    document.getElementById('ds-pools').textContent = activePools;

    // Second KPI row
    const ficaApproved = nonArchived.filter(i => i.fica_status === 'approved' || i.kyc_status === 'approved').length;
    const ficaRate = nonArchived.length ? Math.round((ficaApproved / nonArchived.length) * 100) : 0;
    const dsRate = document.getElementById('ds-fica-rate');
    if (dsRate) dsRate.textContent = `${ficaRate}%`;

    const pendingKycCount = nonArchived.filter(i => {
      const fs = i.fica_status; const ks = i.kyc_status;
      return fs === 'pending' || fs === 'in_progress' || fs === 'submitted' || ks === 'pending';
    }).length;
    const dsPendKyc = document.getElementById('ds-pending-kyc');
    if (dsPendKyc) dsPendKyc.textContent = pendingKycCount;

    const in90Days = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const now90 = new Date();
    const upcomingMaturities = STATE.investments.filter(i => {
      if (i.status !== 'active' || !i.maturity_date) return false;
      const md = new Date(i.maturity_date);
      return md >= now90 && md <= in90Days;
    }).length;
    const dsUpcoming = document.getElementById('ds-upcoming-maturities');
    if (dsUpcoming) dsUpcoming.textContent = upcomingMaturities;

    const pendingWithdrawals = (STATE.transactions || []).filter(t => t.type === 'withdrawal' && t.status === 'pending').length;
    const dsPendWd = document.getElementById('ds-pending-withdrawals');
    if (dsPendWd) dsPendWd.textContent = pendingWithdrawals;

    // Real month-over-month trend calculations
    (() => {
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

      const _trendPct = (curr, prev) => {
        if (!prev && !curr) return null;
        if (!prev) return curr > 0 ? '+100' : '0';
        return (((curr - prev) / Math.abs(prev)) * 100).toFixed(0);
      };
      const _setTrend = (elId, pct) => {
        const el = document.getElementById(elId);
        if (!el || pct === null) return;
        const num = parseFloat(pct);
        const isUp = num >= 0;
        el.className = `stat-card__trend ${isUp ? 'up' : 'down'}`;
        el.innerHTML = `<i class="fa-solid fa-arrow-trend-${isUp ? 'up' : 'down'}"></i> ${isUp ? '+' : ''}${pct}%`;
      };

      // Investors: new signups this month vs last month
      const invThis = STATE.investors.filter(i => new Date(i.created_at || 0) >= thisMonthStart).length;
      const invLast = STATE.investors.filter(i => {
        const d = new Date(i.created_at || 0);
        return d >= lastMonthStart && d <= lastMonthEnd;
      }).length;
      _setTrend('ds-trend-investors', _trendPct(invThis, invLast));

      // AUM: new investments this month vs last month (exclude cancelled/withdrawn)
      const aumThis = STATE.investments.filter(i => ['active', 'matured'].includes(i.status) && new Date(i.created_at || 0) >= thisMonthStart).reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
      const aumLast = STATE.investments.filter(i => {
        if (!['active', 'matured'].includes(i.status)) return false;
        const d = new Date(i.created_at || 0);
        return d >= lastMonthStart && d <= lastMonthEnd;
      }).reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
      _setTrend('ds-trend-invested', _trendPct(aumThis, aumLast));

      // Returns: returns paid this month vs last month
      const retThis = STATE.transactions.filter(t => t.type === 'return' && t.status === 'completed' && new Date(t.created_at || t.transaction_date || 0) >= thisMonthStart).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      const retLast = STATE.transactions.filter(t => {
        if (t.type !== 'return' || t.status !== 'completed') return false;
        const d = new Date(t.created_at || t.transaction_date || 0);
        return d >= lastMonthStart && d <= lastMonthEnd;
      }).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
      _setTrend('ds-trend-returns', _trendPct(retThis, retLast));
    })();

    // Badge counts (reuse pendingKycCount computed above for consistency)
    document.getElementById('kycBadge').textContent = pendingKycCount;

    // Fetch ticket count for welcome strip
    let openTickets = 0;
    let tickets = [];
    try {
      const tktRes = await API.tickets.list({ limit: 50 });
      tickets = tktRes.data || [];
      STATE.tickets = tickets;
      openTickets = tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length;
      const tktBadge = document.getElementById('ticketBadge');
      if (tktBadge) { tktBadge.textContent = openTickets; tktBadge.style.display = openTickets > 0 ? '' : 'none'; }
    } catch (_) {}

    // Build dynamic notification panel
    loadAdminNotifications(STATE.investors, STATE.transactions, tickets);

    // Populate welcome strip
    const jwtUser = (typeof Auth !== 'undefined') ? Auth.getUser() : null;
    const wIdent  = { name: null, role: null };
    try {
      const raw = localStorage.getItem('staffSession');
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.empId && s.expiresAt > Date.now()) {
          wIdent.name = `${s.firstName || ''} ${s.lastName || ''}`.trim();
          wIdent.role = s.role;
        }
      }
    } catch (_) {}
    if (!wIdent.name && jwtUser) {
      wIdent.name = `${jwtUser.firstName || ''} ${jwtUser.lastName || ''}`.trim() || jwtUser.email || null;
      wIdent.role = jwtUser.role;
    }
    _populateAdminWelcomeStrip(wIdent, pendingKycCount, openTickets);

    renderRecentInvestments();
    renderOpenPoolsWidget();
    renderPendingActions();
    _markRefreshed('activity');
    renderActivityFeed();
    renderAumChart();
    renderProductMixChart();
    updateSidebarBadges();

    // Auto-refresh KPI cards every 30 seconds
    if (!window._dashRefreshTimer) {
      window._dashRefreshTimer = setInterval(async () => {
        if (STATE.currentView !== 'dashboard') return;
        try {
          const [invRes, poolRes, invstRes, txnRes] = await Promise.all([
            API.investors.list({ limit: 5000 }),
            API.pools.list({ limit: 1000 }),
            API.investments.list({ limit: 5000 }),
            API.transactions.list({ limit: 5000 })
          ]);
          STATE.investors = invRes.data || [];
          STATE.pools = poolRes.data || [];
          STATE.investments = invstRes.data || [];
          STATE.transactions = txnRes.data || [];
          const nonArchived = STATE.investors.filter(i => i.status !== 'archived');
          const totalInvested = STATE.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
          const totalReturns  = STATE.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
          const activePools = STATE.pools.filter(p => ['open', 'active', 'filling'].includes(p.status)).length;
          document.getElementById('ds-investors').textContent = STATE.investors.length;
          document.getElementById('ds-invested').textContent = Utils.rand(totalInvested);
          document.getElementById('ds-returns').textContent = Utils.rand(totalReturns);
          document.getElementById('ds-pools').textContent = activePools;
          renderPendingActions();
          updateSidebarBadges();
        } catch (_) {}
      }, 30000);
    }

    _hideLoadingBar();
  } catch (e) {
    _hideLoadingBar();
    Toast.error('Failed to load dashboard data');
    console.error(e);
  }
}

function updateSidebarBadges() {
  const _nonArchived = STATE.investors.filter(i => i.status !== 'archived');
  const pendingKyc = _nonArchived.filter(i => {
    const fs = i.fica_status; const ks = i.kyc_status;
    return fs === 'pending' || fs === 'in_progress' || fs === 'submitted' || ks === 'pending';
  }).length;
  const kycBadge = document.getElementById('kycBadge');
  if (kycBadge) kycBadge.textContent = pendingKyc;

  const pendingWith = STATE.transactions.filter(t => t.type === 'withdrawal' && t.status === 'pending').length;
  const withBadge = document.getElementById('withdrawalBadge');
  if (withBadge) { withBadge.textContent = pendingWith; withBadge.style.display = pendingWith > 0 ? '' : 'none'; }

  const openTkts = STATE.tickets ? STATE.tickets.filter(t => ['open','in_progress'].includes(t.status)).length : 0;
  const tktBadge = document.getElementById('ticketBadge');
  if (tktBadge) tktBadge.textContent = openTkts;
}

function renderRecentInvestments() {
  const body = document.getElementById('recentInvestmentsBody');
  const recent = [...STATE.investments].sort((a, b) => new Date(b.start_date || b.created_at) - new Date(a.start_date || a.created_at)).slice(0, 8);

  if (!recent.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No investments yet</td></tr>'; return; }

  body.innerHTML = recent.map(inv => {
    const investor = STATE.investors.find(i => i.id === inv.investor_id);
    const name = inv.investor_name
      || (investor ? `${investor.first_name || ''} ${investor.last_name || ''}`.trim() : '')
      || inv.investor_id || '—';
    // Resolve product_type from the investment, falling back to the associated pool
    const pool = inv.pool_id ? STATE.pools.find(p => p.id === inv.pool_id) : null;
    const productType = inv.product_type || pool?.product_type || '';
    const pi = Utils.productInfo(productType);
    return `<tr>
      <td><div class="flex-center gap-8">
        <div class="avatar avatar--sm avatar--gold" style="flex-shrink:0">${Utils.initials(name)}</div>
        <span class="td-strong clip">${_esc(name)}</span>
      </div></td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700 clip">${Utils.rand(inv.amount)}</td>
      <td class="td-green clip">${Utils.pct(inv.annual_rate || inv.expected_return_rate)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td class="td-muted clip">${Utils.date(inv.start_date || inv.created_at)}</td>
    </tr>`;
  }).join('');
}

function renderOpenPoolsWidget() {
  const el = document.getElementById('openPoolsWidget');
  const open = STATE.pools.filter(p => ['open', 'filling', 'active'].includes(p.status)).slice(0, 4);

  if (!open.length) { el.innerHTML = '<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>No open pools</p></div>'; return; }

  el.innerHTML = open.map(p => {
    const pi = Utils.productInfo(p.product_type === 'smme' ? 'short_term' : p.product_type);
    const pct = Utils.poolFillPct(p);
    return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
      <div class="flex-between mb-4">
        <span style="font-size:0.82rem;font-weight:700;color:var(--text)">${p.name}</span>
        <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
      </div>
      <div class="pool-card__progress-label">
        <span>${Utils.rand(p.live_raised ?? p.raised_amount ?? 0)} raised</span>
        <span>${pct}% of ${Utils.rand(p.target_amount)}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${p.live_investor_count ?? p.investor_count ?? 0} investors · Closes ${Utils.date(p.end_date)}</div>
    </div>`;
  }).join('');
}

function renderPendingActions() {
  const el = document.getElementById('pendingActionsWidget');
  const actions = [];

  const pendingFica = STATE.investors.filter(i => i.status === 'pending_fica' || i.fica_status === 'submitted').length;
  if (pendingFica) actions.push({ icon: 'fa-id-card', color: 'var(--orange)', text: `${pendingFica} FICA review(s) pending`, sub: 'Review identity documents before investors can fund or invest.', view: 'kyc', cta: 'Open KYC', priority: 1 });

  const pendingWithdrawals = STATE.transactions.filter(t => t.type === 'withdrawal' && t.status === 'pending').length;
  if (pendingWithdrawals) actions.push({ icon: 'fa-arrow-up-from-bracket', color: '#ef4444', text: `${pendingWithdrawals} withdrawal request(s) waiting`, sub: 'Approve or reject payouts to keep cash movement on time.', view: 'withdrawals', cta: 'Review withdrawals', priority: 2 });

  const openSupport = (STATE.tickets || []).filter(t => t.status === 'open' || t.status === 'in_progress').length;
  if (openSupport) actions.push({ icon: 'fa-headset', color: 'var(--blue)', text: `${openSupport} support ticket(s) need replies`, sub: 'Resolve investor questions before they become complaints or churn risk.', view: 'support', cta: 'Open support', priority: 3 });

  const noInstruction = STATE.investments.filter(i => i.status === 'matured' && i.maturity_instruction === 'pending').length;
  if (noInstruction) actions.push({ icon: 'fa-hourglass-end', color: 'var(--red)', text: `${noInstruction} maturity instruction(s) missing`, sub: 'Investors are waiting to reinvest or pay out matured capital.', view: 'maturity', cta: 'Review maturities', priority: 4 });

  const pendingTransactions = STATE.transactions.filter(t => t.status === 'pending' && t.type !== 'withdrawal').length;
  if (pendingTransactions) actions.push({ icon: 'fa-arrows-rotate', color: 'var(--green)', text: `${pendingTransactions} transaction(s) pending`, sub: 'Clear deposits, returns and reconciliations to keep reporting current.', view: 'transactions', cta: 'Open transactions', priority: 5 });

  actions.sort((a, b) => a.priority - b.priority);

  if (!actions.length) {
    el.innerHTML = '<div class="empty-state" style="padding:16px"><i class="fa-solid fa-check-circle" style="color:var(--green)"></i><p>All clear! No pending actions.</p></div>';
    return;
  }

  el.innerHTML = actions.map(a => `
    <button type="button" style="width:100%;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--dark-3);margin-bottom:10px;cursor:pointer;transition:transform .15s ease, box-shadow .15s ease" onclick="navigate('${a.view}', document.querySelector('[data-view=${a.view}]'))" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,0.3)';this.style.borderColor='rgba(254,194,79,0.3)'" onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor=''">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:34px;height:34px;border-radius:10px;background:${a.color}18;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid ${a.icon}" style="color:${a.color};font-size:0.8rem"></i>
        </div>
        <div style="min-width:0;flex:1">
          <div style="font-size:0.8rem;font-weight:800;color:var(--text);line-height:1.35">${a.text}</div>
          <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px;line-height:1.45">${a.sub}</div>
          <div style="margin-top:8px;font-size:0.72rem;font-weight:800;color:${a.color}">${a.cta} →</div>
        </div>
      </div>
    </button>`).join('');
}

let _activityPage = 1;
const _ACTIVITY_PAGE_SIZE = 5;

function renderActivityFeed(page) {
  const el = document.getElementById('activityFeedWidget');
  if (!el) return;
  if (page !== undefined) _activityPage = page;

  const events = [];

  // New investor registrations
  STATE.investors.forEach(inv => {
    const ts = inv.created_at || inv.registration_date;
    if (!ts) return;
    events.push({
      ts: new Date(ts),
      icon: 'fa-user-plus', color: '#656565',
      text: `<strong>${_esc(inv.first_name)} ${_esc(inv.last_name)}</strong> registered`,
      sub: inv.email || inv.id,
      view: 'investors',
    });
  });

  // New investments
  STATE.investments.forEach(inv => {
    const ts = inv.start_date || inv.created_at;
    if (!ts) return;
    events.push({
      ts: new Date(ts),
      icon: 'fa-coins', color: '#fec24f',
      text: `<strong>${_esc(inv.investor_name || inv.investor_id)}</strong> invested ${Utils.rand(inv.amount)}`,
      sub: _esc(inv.pool_name || inv.pool_id || ''),
      view: 'investments',
    });
  });

  // Completed transactions (returns/payouts)
  STATE.transactions.filter(t => ['return','payout'].includes(t.type) && t.status === 'completed').forEach(t => {
    const ts = t.transaction_date || t.created_at;
    if (!ts) return;
    events.push({
      ts: new Date(ts),
      icon: 'fa-arrow-trend-up', color: '#22c55e',
      text: `<strong>${_esc(t.investor_name || t.investor_id)}</strong> received ${Utils.rand(t.amount)} ${t.type}`,
      sub: _esc(t.reference || ''),
      view: 'transactions',
    });
  });

  // KYC submissions
  STATE.investors.filter(i => ['pending_fica','fica_submitted'].includes(i.status)).forEach(inv => {
    const ts = inv.updated_at || inv.created_at;
    if (!ts) return;
    events.push({
      ts: new Date(ts),
      icon: 'fa-id-card', color: '#fec24f',
      text: `<strong>${_esc(inv.first_name)} ${_esc(inv.last_name)}</strong> submitted KYC docs`,
      sub: inv.id,
      view: 'kyc',
    });
  });

  // Sort descending; keep all for pagination
  events.sort((a, b) => b.ts - a.ts);

  if (!events.length) {
    el.innerHTML = '<div class="empty-state" style="padding:12px"><i class="fa-solid fa-bolt"></i><div class="empty-state__title">No activity yet</div></div>';
    return;
  }

  const totalPages = Math.ceil(events.length / _ACTIVITY_PAGE_SIZE);
  _activityPage = Math.max(1, Math.min(_activityPage, totalPages));
  const start = (_activityPage - 1) * _ACTIVITY_PAGE_SIZE;
  const page_items = events.slice(start, start + _ACTIVITY_PAGE_SIZE);

  const _fmtRelative = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60)  return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return ts.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  };

  const rows = page_items.map((e, i) => `
    <div style="display:flex;align-items:flex-start;gap:12px;padding:11px 16px;${i < page_items.length-1 ? 'border-bottom:1px solid var(--border)' : ''};cursor:pointer;transition:background 0.15s"
         onmouseover="this.style.background='var(--dark-2)'" onmouseout="this.style.background=''"
         onclick="navigate('${e.view}', document.querySelector('[data-view=${e.view}]'))">
      <div style="width:30px;height:30px;border-radius:50%;background:${e.color}18;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">
        <i class="fa-solid ${e.icon}" style="color:${e.color};font-size:0.75rem"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.79rem;color:var(--text);line-height:1.4">${e.text}</div>
        ${e.sub ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.sub}</div>` : ''}
      </div>
      <div style="font-size:0.68rem;color:var(--text-dim);white-space:nowrap;flex-shrink:0;margin-top:2px">${_fmtRelative(e.ts)}</div>
    </div>
  `).join('');

  const pagination = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-top:1px solid var(--border)">
      <button class="btn btn--ghost btn--sm" onclick="renderActivityFeed(${_activityPage - 1})" ${_activityPage <= 1 ? 'disabled' : ''} style="font-size:0.72rem">
        <i class="fa-solid fa-chevron-left"></i> Prev
      </button>
      <span style="font-size:0.72rem;color:var(--text-muted)">${_activityPage} / ${totalPages}</span>
      <button class="btn btn--ghost btn--sm" onclick="renderActivityFeed(${_activityPage + 1})" ${_activityPage >= totalPages ? 'disabled' : ''} style="font-size:0.72rem">
        Next <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>` : '';

  el.innerHTML = rows + pagination;

  _setRefreshLabel('activityRefreshed', 'activity');
}

function switchAumTab(range, btn) {
  // Update active tab styling
  const tabBtns = document.querySelectorAll('.aum-tabs .tab-btn');
  tabBtns.forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Re-render chart with selected range
  renderAumChart(range);
}

function renderAumChart(range) {
  const ctx = document.getElementById('aumChart');
  if (!ctx) return;

  // Determine how many months back to show
  const monthCount = range === 'all' ? 36 : range === '1y' ? 12 : 6;

  // Build calendar months going back monthCount periods
  const now = new Date();
  const monthStarts = [], monthLabels = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthStarts.push(d);
    monthLabels.push(d.toLocaleString('en-ZA', { month: 'short', year: monthCount > 12 ? '2-digit' : undefined }));
  }

  // Cumulative AUM: sum of investments active at end of each month
  const aumData = monthStarts.map(m => {
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
    return STATE.investments.filter(inv => {
      const created = new Date(inv.created_at || inv.start_date || 0);
      return created <= end && inv.status === 'active';
    }).reduce((s, inv) => s + (parseFloat(inv.amount) || 0), 0);
  });

  // Returns paid per month
  const returnsData = monthStarts.map(m => {
    const start = new Date(m.getFullYear(), m.getMonth(), 1);
    const end   = new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 59, 59);
    return STATE.transactions.filter(t => {
      if (t.type !== 'return' || t.status !== 'completed') return false;
      const d = new Date(t.created_at || t.transaction_date || 0);
      return d >= start && d <= end;
    }).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  });

  if (STATE.charts.aum) STATE.charts.aum.destroy();
  STATE.charts.aum = new Chart(ctx, {
    type: 'line',
    data: {
      labels: monthLabels,
      datasets: [
        {
          label: 'AUM (R)',
          data: aumData,
          borderColor: '#fec24f',
          backgroundColor: c => {
            const g = c.chart.ctx.createLinearGradient(0, 0, 0, 280);
            g.addColorStop(0, 'rgba(254,194,79,0.18)');
            g.addColorStop(1, 'rgba(254,194,79,0)');
            return g;
          },
          fill: true, tension: 0.4, borderWidth: 2.5,
          pointRadius: 4, pointBackgroundColor: '#fec24f',
        },
        {
          label: 'Returns Paid (R)',
          data: returnsData,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.08)',
          fill: true, tension: 0.4, borderWidth: 2,
          pointRadius: 3, pointBackgroundColor: '#22c55e',
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#7a92a8', font: { size: 11 }, boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8',
          borderColor: 'rgba(254,194,79,0.3)', borderWidth: 1,
          callbacks: { label: c => ` ${c.dataset.label}: ${Utils.rand(c.parsed.y)}` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', font: { size: 11 }, callback: v => 'R' + (v / 1000000).toFixed(1) + 'M' } }
      }
    }
  });
}

function renderProductMixChart() {
  const ctx = document.getElementById('productMixChart');
  if (!ctx) return;

  const products = { cattle: 0, solar_7yr: 0, solar_6yr: 0, solar_5yr: 0, short_term: 0, delivery_bikes: 0 };
  STATE.investments.filter(i => i.status === 'active').forEach(i => {
    // Resolve product_type from investment, falling back to the linked pool
    const pool = i.pool_id ? STATE.pools.find(p => p.id === i.pool_id) : null;
    const type = i.product_type || pool?.product_type || '';
    // Normalise delivery_bike → delivery_bikes
    const key = type === 'delivery_bike' ? 'delivery_bikes' : type;
    if (key && products[key] !== undefined) products[key] += (parseFloat(i.amount) || 0);
  });

  const labels = ['Cattle Investment', 'Solar Investment (7yr)', 'Solar Investment (6yr)', 'Solar Investment (5yr)', 'Short Term Investment', 'Delivery Bikes'];
  const data = Object.values(products);
  const colors = ['#fec24f', '#22c55e', '#4ade80', '#86efac', '#656565', '#f97316'];

  if (STATE.charts.productMix) STATE.charts.productMix.destroy();
  STATE.charts.productMix = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8',
          callbacks: { label: ctx => ` ${ctx.label}: ${Utils.rand(ctx.parsed)}` }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   INVESTORS
   ═══════════════════════════════════════════════ */
let investorPage = 1;
const INV_PAGE_SIZE = 8;
let filteredInvestors = [];
let filteredSubAccounts = [];

let selectedInvestors = new Set();

async function loadInvestors() {
  try {
    const [res, uRes, saRes] = await Promise.all([
      API.investors.list({ limit: 5000 }),
      API._fetch('GET', 'tables/users', null, { limit: 10000, role: 'investor' }).catch(() => ({ data: [] })),
      API._fetch('GET', 'tables/sub_accounts', null, { limit: 5000 }).catch(() => ({ data: [] })),
    ]);
    STATE.investors = res.data || [];
    STATE.subAccounts = saRes.data || [];
    // Build set of investor_ids that have a login account
    STATE.investorLoginSet = new Set(
      (uRes.data || []).filter(u => u.investor_id).map(u => u.investor_id)
    );
    filteredInvestors = [...STATE.investors];
    filteredSubAccounts = [...STATE.subAccounts];
    _markRefreshed('investors');
    renderInvestorStats();
    renderInvestorsTable();
    setupInvestorFilters();
    _setRefreshLabel('investorsRefreshed', 'investors');
  } catch (e) { Toast.error('Failed to load investors'); }
}

function updateBulkBar() {
  const bar = document.getElementById('invBulkBar');
  const cnt = document.getElementById('invBulkCount');
  if (bar) bar.style.display = selectedInvestors.size ? 'flex' : 'none';
  if (cnt) cnt.textContent = `${selectedInvestors.size} investor${selectedInvestors.size !== 1 ? 's' : ''} selected`;
  _updateSelectAllBanner();
}

function _updateSelectAllBanner() {
  const banner = document.getElementById('invSelectAllBanner');
  if (!banner) return;
  const total = filteredInvestors.length;
  const allSelected = selectedInvestors.size === total && total > 0;
  const start = (investorPage - 1) * INV_PAGE_SIZE;
  const pageIds = filteredInvestors.slice(start, start + INV_PAGE_SIZE).map(i => i.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every(id => selectedInvestors.has(id));
  if (allSelected) {
    banner.style.display = 'block';
    banner.innerHTML = `All <strong>${total}</strong> investors are selected. <a href="#" style="color:var(--orange);font-weight:700;text-decoration:underline" onclick="clearInvestorSelection();return false">Clear selection</a>`;
  } else if (pageAllSelected && total > pageIds.length) {
    banner.style.display = 'block';
    banner.innerHTML = `All <strong>${pageIds.length}</strong> investors on this page are selected. <a href="#" style="color:var(--orange);font-weight:700;text-decoration:underline" onclick="selectAllAcrossPages();return false">Select all ${total} investors</a>`;
  } else {
    banner.style.display = 'none';
    banner.innerHTML = '';
  }
}

function selectAllAcrossPages() {
  filteredInvestors.forEach(inv => selectedInvestors.add(inv.id));
  renderInvestorsTable();
  updateBulkBar();
}

function toggleInvestorSelect(id, checked) {
  if (checked) selectedInvestors.add(id);
  else selectedInvestors.delete(id);
  updateBulkBar();
  const allCb = document.getElementById('invSelectAll');
  if (allCb) {
    const start = (investorPage - 1) * INV_PAGE_SIZE;
    const page  = filteredInvestors.slice(start, start + INV_PAGE_SIZE);
    allCb.checked = page.length > 0 && page.every(i => selectedInvestors.has(i.id));
    allCb.indeterminate = !allCb.checked && page.some(i => selectedInvestors.has(i.id));
  }
}

function toggleAllInvestors(cb) {
  const start = (investorPage - 1) * INV_PAGE_SIZE;
  const page  = filteredInvestors.slice(start, start + INV_PAGE_SIZE);
  page.forEach(inv => { if (cb.checked) selectedInvestors.add(inv.id); else selectedInvestors.delete(inv.id); });
  renderInvestorsTable();
  updateBulkBar();
}

function clearInvestorSelection() {
  selectedInvestors.clear();
  const banner = document.getElementById('invSelectAllBanner');
  if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }
  renderInvestorsTable();
  updateBulkBar();
}

async function bulkSendLoginInvites() {
  const ids = [...selectedInvestors];
  if (!ids.length) return;
  const names = STATE.investors.filter(i => ids.includes(i.id))
    .map(i => `${i.first_name || ''} ${i.last_name || ''}`.trim()).filter(Boolean);
  const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  if (!await Confirm.ask(`Send login invites to ${ids.length} investor${ids.length !== 1 ? 's' : ''}?`, {
    body: `This creates login accounts and emails a setup link to: ${preview}. Links are valid for 7 days.`,
    confirmLabel: 'Send Invites',
  })) return;
  try {
    const res = await API._fetch('POST', 'auth/bulk-invite-investors', { investor_ids: ids });
    const msg = `${res.sent} invite${res.sent !== 1 ? 's' : ''} sent` +
      (res.skipped ? `, ${res.skipped} skipped (no email)` : '') +
      (res.failed?.length ? `, ${res.failed.length} failed` : '');
    Toast.success(msg);
    // Update login set so newly invited investors show "Has Login" immediately
    ids.forEach(id => STATE.investorLoginSet.add(id));
    selectedInvestors.clear();
    renderInvestorsTable();
    updateBulkBar();
  } catch (e) { Toast.error('Bulk invite failed: ' + (e.message || 'unknown error')); }
}

async function bulkArchiveInvestors() {
  const ids = [...selectedInvestors];
  if (!ids.length) return;
  const names = STATE.investors.filter(i => ids.includes(i.id))
    .map(i => `${i.first_name || ''} ${i.last_name || ''}`.trim()).filter(Boolean);
  const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  if (!await Confirm.ask(`Archive ${ids.length} investor${ids.length !== 1 ? 's' : ''}?`, {
    body: `This will set status to "archived" for: ${preview}. You can undo immediately.`,
    confirmLabel: 'Archive',
    confirmClass: 'btn--danger',
  })) return;
  const snapshot = ids.map(id => {
    const inv = STATE.investors.find(i => i.id === id);
    return inv ? { id: inv.id, status: inv.status } : null;
  }).filter(Boolean);
  try {
    await Promise.all(ids.map(id => API.investors.update(id, { status: 'archived' })));
    ids.forEach(id => { const inv = STATE.investors.find(i => i.id === id); if (inv) inv.status = 'archived'; });
    selectedInvestors.clear();
    renderInvestorsTable();
    renderInvestorStats();
    updateBulkBar();
    Toast.action(`${ids.length} investor${ids.length !== 1 ? 's' : ''} archived`, 'Undo', async () => {
      try {
        await Promise.all(snapshot.map(s => API.investors.update(s.id, { status: s.status || 'active' })));
        snapshot.forEach(s => { const inv = STATE.investors.find(i => i.id === s.id); if (inv) inv.status = s.status || 'active'; });
        renderInvestorsTable();
        renderInvestorStats();
        Toast.success('Archive undone');
      } catch (ue) { Toast.error('Undo failed: ' + ue.message); }
    });
  } catch (e) { Toast.error('Archive failed: ' + (e.message || 'unknown error')); }
}

async function bulkApproveFica() {
  const ids = [...selectedInvestors];
  if (!ids.length) return;
  const names = STATE.investors.filter(i => ids.includes(i.id))
    .map(i => `${i.first_name || ''} ${i.last_name || ''}`.trim()).filter(Boolean);
  const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  if (!await Confirm.ask(`Approve FICA for ${ids.length} investor${ids.length !== 1 ? 's' : ''}?`, {
    body: `Sets FICA/KYC status to "approved" for: ${preview}.`,
    confirmLabel: 'Approve FICA',
    confirmClass: 'btn--success',
  })) return;
  try {
    await Promise.all(ids.map(id => API.investors.update(id, { fica_status: 'approved', kyc_status: 'approved' })));
    ids.forEach(id => {
      const inv = STATE.investors.find(i => i.id === id);
      if (inv) { inv.fica_status = 'approved'; inv.kyc_status = 'approved'; }
    });
    selectedInvestors.clear();
    renderInvestorsTable();
    updateBulkBar();
    Toast.success(`FICA approved for ${ids.length} investor${ids.length !== 1 ? 's' : ''}`);
  } catch (e) { Toast.error('Bulk FICA approval failed: ' + (e.message || 'unknown error')); }
}

function bulkExportSelected() {
  const ids = [...selectedInvestors];
  if (!ids.length) return;
  const rows = STATE.investors.filter(i => ids.includes(i.id));
  const headers = ['ID','First Name','Last Name','Email','Phone','Gender','Heard About Us','Status','FICA Status','KYC Status','Wallet Balance','Created'];
  const csv = [
    headers.join(','),
    ...rows.map(r => [
      r.id,
      `"${(r.first_name     || '').replace(/"/g, '""')}"`,
      `"${(r.last_name      || '').replace(/"/g, '""')}"`,
      `"${(r.email          || '').replace(/"/g, '""')}"`,
      `"${(r.phone          || '').replace(/"/g, '""')}"`,
      `"${(r.gender         || '').replace(/"/g, '""')}"`,
      `"${(r.heard_about_us || '').replace(/"/g, '""')}"`,
      r.status        || '',
      r.fica_status   || '',
      r.kyc_status    || '',
      r.wallet_balance || '0',
      r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '',
    ].join(','))
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `investors-selected-${Date.now()}.csv`;
  a.click(); URL.revokeObjectURL(url);
  Toast.success(`${rows.length} investor${rows.length !== 1 ? 's' : ''} exported`);
}

/* ── Investor filter presets ─────────────────────────────── */
function _togglePresetDropdown(e) {
  if (e) e.stopPropagation();
  const drop = document.getElementById('filterPresetDrop');
  if (!drop) return;
  if (drop.style.display !== 'none') { drop.style.display = 'none'; return; }
  _renderPresetDropdown();
  drop.style.display = 'block';
  setTimeout(() => {
    document.addEventListener('click', function _closePreset(ev) {
      if (!drop.contains(ev.target)) { drop.style.display = 'none'; document.removeEventListener('click', _closePreset); }
    });
  }, 50);
}

function _renderPresetDropdown() {
  const list = document.getElementById('filterPresetList');
  if (!list) return;
  const presets = _getPresets();
  if (!presets.length) {
    list.innerHTML = '<div style="padding:8px 12px;font-size:0.78rem;color:var(--text-muted)">No saved presets yet</div>';
    return;
  }
  list.innerHTML = presets.map((p, i) => `
    <div style="display:flex;align-items:center;padding:3px 8px 3px 12px;gap:6px">
      <button onclick="_loadInvestorPreset(${i})" style="flex:1;text-align:left;background:none;border:none;cursor:pointer;font-size:0.8rem;color:var(--text);padding:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(p.name)}</button>
      <button onclick="_deleteInvestorPreset(${i});event.stopPropagation()" style="background:none;border:none;cursor:pointer;font-size:0.78rem;color:var(--text-muted);padding:2px 4px;flex-shrink:0" title="Delete">×</button>
    </div>`).join('');
}

function _getPresets() {
  try { return JSON.parse(localStorage.getItem('svc_inv_presets') || '[]'); } catch { return []; }
}

function _saveCurrentPreset() {
  const name = prompt('Preset name:');
  if (!name || !name.trim()) return;
  const filters = {
    status:   document.getElementById('investorStatusFilter')?.value  || '',
    kyc:      document.getElementById('investorKycFilter')?.value     || '',
    province: document.getElementById('investorProvinceFilter')?.value || '',
    login:    document.getElementById('investorLoginFilter')?.value   || '',
    sort:     document.getElementById('investorSortOrder')?.value     || '',
    search:   document.getElementById('globalSearch')?.value          || '',
  };
  const presets = _getPresets();
  presets.push({ name: name.trim(), filters });
  localStorage.setItem('svc_inv_presets', JSON.stringify(presets));
  Toast.success(`Preset "${name.trim()}" saved`);
  const drop = document.getElementById('filterPresetDrop');
  if (drop) drop.style.display = 'none';
}

function _loadInvestorPreset(idx) {
  const p = _getPresets()[idx];
  if (!p) return;
  if (p.filters.status   !== undefined) { const el = document.getElementById('investorStatusFilter');   if (el) el.value = p.filters.status; }
  if (p.filters.kyc      !== undefined) { const el = document.getElementById('investorKycFilter');      if (el) el.value = p.filters.kyc; }
  if (p.filters.province !== undefined) { const el = document.getElementById('investorProvinceFilter'); if (el) el.value = p.filters.province; }
  if (p.filters.login    !== undefined) { const el = document.getElementById('investorLoginFilter');    if (el) el.value = p.filters.login; }
  if (p.filters.sort     !== undefined) { const el = document.getElementById('investorSortOrder');      if (el) el.value = p.filters.sort; }
  if (p.filters.search   !== undefined) { const el = document.getElementById('globalSearch');           if (el) el.value = p.filters.search; }
  applyInvestorFilters();
  const drop = document.getElementById('filterPresetDrop');
  if (drop) drop.style.display = 'none';
  Toast.success(`Preset "${p.name}" loaded`);
}

function _deleteInvestorPreset(idx) {
  const presets = _getPresets();
  const name = presets[idx]?.name || 'preset';
  presets.splice(idx, 1);
  localStorage.setItem('svc_inv_presets', JSON.stringify(presets));
  _renderPresetDropdown();
  Toast.info(`"${name}" deleted`);
}

function renderInvestorStats() {
  const d = STATE.investors;
  const nonArchived = d.filter(i => i.status !== 'archived');
  // AUM from active investments (sub-account investments carry investor_id so are included)
  const liveAUM = STATE.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  // Wallet tile includes both main investor wallets and sub-account wallets
  const saWallet = (STATE.subAccounts || []).reduce((s, sa) => s + (parseFloat(sa.wallet_balance) || 0), 0);
  const totalWallet = nonArchived.reduce((s, i) => s + (parseFloat(i.wallet_balance) || 0), 0) + saWallet;
  document.getElementById('is-total').textContent = nonArchived.length.toLocaleString();
  document.getElementById('is-active').textContent = nonArchived.filter(i => i.status === 'active').length.toLocaleString();
  document.getElementById('is-pending').textContent = nonArchived.filter(i => i.kyc_status === 'pending').length.toLocaleString();
  document.getElementById('is-suspended').textContent = d.filter(i => i.status === 'suspended' || i.status === 'archived').length.toLocaleString();
  document.getElementById('is-wallet').textContent = Utils.rand(totalWallet);
  document.getElementById('is-aum').textContent = Utils.rand(liveAUM);
}

function _invAvatarColor(name) {
  const p = ['#fec24f','#656565','#22c55e','#fec24f','#eda5ff','#656565','#ec4899','#ef4444'];
  let h = 0; for (const c of (name||'?')) h = (h<<5) - h + c.charCodeAt(0);
  return p[Math.abs(h) % p.length];
}

function renderInvestorsTable() {
  const body = document.getElementById('investorsBody');
  const start = (investorPage - 1) * INV_PAGE_SIZE;
  const page = filteredInvestors.slice(start, start + INV_PAGE_SIZE);

  document.getElementById('investorCount').textContent = `${filteredInvestors.length.toLocaleString()} investors`;
  document.getElementById('investorsFooterText').textContent = `Showing ${start + 1}–${Math.min(start + INV_PAGE_SIZE, filteredInvestors.length)} of ${filteredInvestors.length.toLocaleString()}`;

  if (!page.length) {
    const hasFilters = filteredInvestors.length < STATE.investors.length;
    body.innerHTML = hasFilters
      ? _emptyRow('fa-filter-circle-xmark', 'No matching investors', 'Try adjusting the search or filters above.')
      : _emptyRow('fa-users', 'No investors yet', 'Create the first investor using the Add Investor button above.');
    return;
  }

  // Pre-compute live invested totals from investments table (faster than filtering per row)
  const liveInvestedMap = {};
  const liveActiveCountMap = {};
  const liveTotalCountMap = {};
  STATE.investments.forEach(i => {
    liveTotalCountMap[i.investor_id] = (liveTotalCountMap[i.investor_id] || 0) + 1;
    if (i.status === 'active') {
      liveInvestedMap[i.investor_id]   = (liveInvestedMap[i.investor_id]   || 0) + (parseFloat(i.amount) || 0);
      liveActiveCountMap[i.investor_id] = (liveActiveCountMap[i.investor_id] || 0) + 1;
    }
  });

  // Sync select-all checkbox state
  const allCb = document.getElementById('invSelectAll');
  if (allCb) {
    allCb.checked = page.length > 0 && page.every(i => selectedInvestors.has(i.id));
    allCb.indeterminate = !allCb.checked && page.some(i => selectedInvestors.has(i.id));
  }

  const loginSet = STATE.investorLoginSet || new Set();

  body.innerHTML = page.map(inv => {
    const fullName = `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || '—';
    const color = _invAvatarColor(fullName);
    const activeInvCount = liveActiveCountMap[inv.id] || 0;
    const totalInvCount  = liveTotalCountMap[inv.id] || 0;
    const liveInvested   = liveInvestedMap[inv.id] || 0;
    const hasLogin       = loginSet.has(inv.id);
    const isSelected     = selectedInvestors.has(inv.id);
    const kycBadge = inv.kyc_status === 'approved'
      ? '<span class="badge badge--green" style="font-size:0.68rem;padding:2px 6px"><i class="fa-solid fa-shield-check"></i> KYC</span>'
      : inv.kyc_status === 'rejected'
      ? '<span class="badge badge--red" style="font-size:0.68rem;padding:2px 6px">KYC Fail</span>'
      : '<span class="badge badge--yellow" style="font-size:0.68rem;padding:2px 6px">KYC Pending</span>';
    const stBadge   = inv.status === 'archived'
      ? '<span class="badge badge--grey" style="font-size:0.68rem;padding:2px 6px"><i class="fa-solid fa-box-archive"></i> Archived</span>'
      : Utils.statusBadge(inv.status);
    const loginBadge = hasLogin
      ? ''
      : '<span class="badge badge--grey" style="font-size:0.65rem;padding:2px 6px"><i class="fa-solid fa-user-slash"></i> No Login</span>';
    const province = (inv.province||'').replace(/\s+$/,'');
    const _trunc = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block';
    return `<tr style="cursor:pointer;${isSelected ? 'background:rgba(254,194,79,0.06)' : ''}" tabindex="0" onclick="viewInvestor('${inv.id}')" onkeydown="if(event.key==='Enter')viewInvestor('${inv.id}')">
      <td style="overflow:hidden;padding:8px 10px" onclick="event.stopPropagation()">
        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleInvestorSelect('${inv.id}', this.checked)">
      </td>
      <td style="overflow:hidden" onclick="event.stopPropagation()">
        <div class="flex-center gap-8" style="min-width:0">
          <div style="width:30px;height:30px;border-radius:50%;background:${color};color:#fff;font-size:0.63rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${Utils.initials(fullName)}</div>
          <div style="min-width:0;flex:1">
            <div class="td-strong" style="font-size:0.81rem;${_trunc}">${fullName}</div>
            <div style="font-size:0.67rem;font-family:monospace;color:var(--gold);${_trunc}">${inv.id || ''}</div>
            ${province ? `<div style="font-size:0.67rem;color:var(--text-muted);${_trunc}">${province}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="overflow:hidden">
        <div style="font-size:0.75rem;${_trunc}">${inv.email || '—'}</div>
        <div class="td-muted" style="font-size:0.71rem;${_trunc}">${inv.phone || '—'}</div>
      </td>
      <td style="overflow:hidden">
        <div style="display:flex;flex-direction:column;gap:3px">${kycBadge}${stBadge}${loginBadge}</div>
      </td>
      <td style="overflow:hidden">
        <div class="td-gold fw-700" style="font-size:0.81rem;${_trunc}">${Utils.rand(parseFloat(inv.wallet_balance) || 0)}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);${_trunc}">${Utils.rand(liveInvested)} invested</div>
      </td>
      <td style="overflow:hidden">
        <div style="font-weight:700;font-size:0.81rem">${totalInvCount}</div>
        <div class="td-muted" style="font-size:0.7rem">${activeInvCount} active</div>
      </td>
      <td style="overflow:hidden" onclick="event.stopPropagation()">
        <div class="flex-center gap-5">
          <button class="btn btn--secondary btn--sm" onclick='viewInvestor(${JSON.stringify(inv.id)})'><i class="fa-solid fa-eye"></i></button>
          ${inv.status === 'archived'
            ? `<button class="btn btn--sm" style="background:rgba(253,186,116,.15);color:#fb923c;border:1px solid rgba(253,186,116,.3)" onclick='unarchiveInvestor(${JSON.stringify(inv.id)}, this)' title="Unarchive investor"><i class="fa-solid fa-box-open"></i></button>`
            : `<button class="btn btn--sm" style="background:rgba(156,163,175,.1);color:var(--text-muted);border:1px solid rgba(156,163,175,.2)" onclick='confirmArchiveInvestor(${JSON.stringify(inv.id)}, this)' title="Archive investor"><i class="fa-solid fa-box-archive"></i></button>`}
        </div>
      </td>
    </tr>`;
  }).join('');

  const pages = Math.ceil(filteredInvestors.length / INV_PAGE_SIZE);
  const pag = document.getElementById('investorsPagination');
  if (pag) pag.innerHTML = [
    investorPage > 1 ? `<button class="page-btn" onclick="investorPage--;renderInvestorsTable()">&#8249; Prev</button>` : `<button class="page-btn" disabled style="opacity:0.35">&#8249; Prev</button>`,
    `<span class="page-btn active" style="cursor:default;min-width:60px;text-align:center">${investorPage} / ${pages||1}</span>`,
    investorPage < pages ? `<button class="page-btn" onclick="investorPage++;renderInvestorsTable()">Next &#8250;</button>` : `<button class="page-btn" disabled style="opacity:0.35">Next &#8250;</button>`,
  ].join('');

  // Append sub-account rows after paginated investor rows (uses filteredSubAccounts for search)
  const _visibleSa = filteredSubAccounts || [];
  if (_visibleSa.length) {
    const saInvMap = {};
    STATE.investments.forEach(i => {
      if (i.sub_account_id) {
        saInvMap[i.sub_account_id] = (saInvMap[i.sub_account_id] || 0) + 1;
      }
    });
    const parentMap = {};
    STATE.investors.forEach(inv => { parentMap[inv.id] = inv; });
    const _trunc = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block';
    const _ficaBadge = (status) => {
      const s = String(status || '').trim();
      if (s === 'approved' || s === 'verified' || s === 'Approved' || s === 'Verified')
        return '<span class="badge badge--green" style="font-size:0.65rem;padding:2px 6px"><i class="fa-solid fa-shield-check"></i> KYC Verified</span>';
      if (s === 'rejected' || s === 'Declined')
        return '<span class="badge badge--red" style="font-size:0.65rem;padding:2px 6px">Rejected</span>';
      if (s === 'flagged')
        return '<span class="badge badge--red" style="font-size:0.65rem;padding:2px 6px"><i class="fa-solid fa-flag"></i> Flagged</span>';
      if (!s || s === 'not_started' || s === 'Unverified')
        return '<span class="badge badge--grey" style="font-size:0.65rem;padding:2px 6px">No FICA Uploaded</span>';
      // pending, submitted, in_progress, Outstanding, Pending, Outstanding → Pending Review
      return '<span class="badge badge--yellow" style="font-size:0.65rem;padding:2px 6px">Pending Review</span>';
    };
    const saRows = _visibleSa.map(sa => {
      const parent = parentMap[sa.parent_investor_id] || {};
      const typeLabel = (sa.type || 'standard').replace(/_/g, ' ');
      const typeCap = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);
      const invCount = saInvMap[sa.id] || 0;
      const balance  = Utils.rand(parseFloat(sa.wallet_balance) || 0);
      const saRef    = sa.sa_reference || '—';
      const ficaBadge = _ficaBadge(parent.fica_status);
      const bankBadge = sa.sa_bank_status === 'approved'
        ? '<span class="badge badge--green" style="font-size:0.65rem;padding:2px 6px">Bank ✓</span>'
        : sa.sa_bank_status === 'rejected'
        ? '<span class="badge badge--red" style="font-size:0.65rem;padding:2px 6px">Bank ✗</span>'
        : '';
      return `<tr style="cursor:pointer;background:rgba(237,165,255,0.04);border-left:3px solid #eda5ff" onclick="viewSubAccount('${sa.id}')">
        <td style="overflow:hidden;padding:8px 10px"></td>
        <td style="overflow:hidden">
          <div class="flex-center gap-8" style="min-width:0">
            <div style="width:30px;height:30px;border-radius:50%;background:#3d1f4a;color:#eda5ff;font-size:0.63rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid fa-circle-nodes"></i></div>
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
                <span class="td-strong" style="font-size:0.81rem">${_esc(sa.name || '—')}</span>
                <span style="background:rgba(237,165,255,0.18);color:#eda5ff;border:1px solid rgba(237,165,255,0.35);border-radius:4px;font-size:0.62rem;font-weight:700;padding:1px 6px;white-space:nowrap">Sub Account</span>
              </div>
              <div style="font-size:0.67rem;font-family:monospace;color:#ffe86a;${_trunc}">${saRef}</div>
              <div style="font-size:0.67rem;color:var(--text-muted);${_trunc}">${typeCap}</div>
            </div>
          </div>
        </td>
        <td style="overflow:hidden">
          <div style="font-size:0.72rem;color:var(--text-muted);${_trunc}">Sub-account</div>
          <div style="font-size:0.72rem;color:var(--text-dim);${_trunc}">${_esc(parent.email || '—')}</div>
        </td>
        <td style="overflow:hidden">
          <div style="display:flex;flex-direction:column;gap:3px">${ficaBadge}${bankBadge}</div>
        </td>
        <td style="overflow:hidden">
          <div class="td-gold fw-700" style="font-size:0.81rem;${_trunc}">${balance}</div>
        </td>
        <td style="overflow:hidden">
          <div style="font-weight:700;font-size:0.81rem">${invCount}</div>
        </td>
        <td style="overflow:hidden" onclick="event.stopPropagation()">
          <button class="btn btn--secondary btn--sm" onclick="viewSubAccount('${sa.id}')"><i class="fa-solid fa-eye"></i> View</button>
        </td>
      </tr>`;
    }).join('');
    body.insertAdjacentHTML('beforeend', saRows);
  }
}

function setupInvestorFilters() {
  const search  = document.getElementById('investorSearch');
  const statusF = document.getElementById('investorStatusFilter');
  const kycF    = document.getElementById('investorKycFilter');
  const provF   = document.getElementById('investorProvinceFilter');
  const loginF  = document.getElementById('investorLoginFilter');
  const sortSel = document.getElementById('investorSortOrder');

  // Restore saved filter state
  const saved = STATE.filters.investors;
  if (saved) {
    if (saved.q)  search.value  = saved.q;
    if (saved.st) statusF.value = saved.st;
    if (saved.ky) kycF.value    = saved.ky;
    if (saved.pv) provF.value   = saved.pv;
    if (saved.lo && loginF) loginF.value = saved.lo;
    if (saved.so && sortSel) sortSel.value = saved.so;
  }

  const filter = Utils.debounce(() => {
    const q  = (search.value || '').toLowerCase();
    const st = statusF.value;
    const ky = kycF.value;
    const pv = provF.value;
    const lo = loginF ? loginF.value : '';
    const so = sortSel ? sortSel.value : 'date_desc';
    const loginSet = STATE.investorLoginSet || new Set();
    STATE.filters.investors = { q, st, ky, pv, lo, so };
    filteredInvestors = STATE.investors.filter(inv => {
      const name = `${inv.first_name||''} ${inv.last_name||''}`.toLowerCase();
      const matchQ  = !q  || name.includes(q)
                          || (inv.email||'').toLowerCase().includes(q)
                          || (inv.id||'').toLowerCase().includes(q)
                          || (inv.phone||'').includes(q)
                          || (inv.id_number||'').includes(q);
      const matchSt = st === 'archived' ? (inv.status === 'archived' || inv.status === 'suspended')
        : st ? inv.status === st
        : true;
      const matchKy = !ky || inv.kyc_status === ky;
      const matchPv = !pv || (inv.province||'').toLowerCase().includes(pv.toLowerCase());
      const matchLo = !lo
        || (lo === 'no_login'  && !loginSet.has(inv.id))
        || (lo === 'has_login' &&  loginSet.has(inv.id));
      return matchQ && matchSt && matchKy && matchPv && matchLo;
    });

    // Sort
    filteredInvestors = [...filteredInvestors].sort((a, b) => {
      if (so === 'date_asc')      return new Date(a.date_joined || 0) - new Date(b.date_joined || 0);
      if (so === 'name_asc')      return `${a.first_name||''} ${a.last_name||''}`.localeCompare(`${b.first_name||''} ${b.last_name||''}`);
      if (so === 'name_desc')     return `${b.first_name||''} ${b.last_name||''}`.localeCompare(`${a.first_name||''} ${a.last_name||''}`);
      if (so === 'wallet_desc')   return (parseFloat(b.wallet_balance) || 0) - (parseFloat(a.wallet_balance) || 0);
      if (so === 'wallet_asc')    return (parseFloat(a.wallet_balance) || 0) - (parseFloat(b.wallet_balance) || 0);
      if (so === 'invested_desc') return (parseFloat(b.total_invested) || 0) - (parseFloat(a.total_invested) || 0);
      // date_desc (default)
      return new Date(b.date_joined || 0) - new Date(a.date_joined || 0);
    });

    // Filter sub-accounts by name or SA reference (ignore status/kyc/province filters)
    const _pmap = {};
    STATE.investors.forEach(inv => { _pmap[inv.id] = inv; });
    filteredSubAccounts = STATE.subAccounts.filter(sa => {
      if (!q) return true;
      const p = _pmap[sa.parent_investor_id] || {};
      return (sa.name||'').toLowerCase().includes(q)
        || (sa.sa_reference||'').toLowerCase().includes(q)
        || `${p.first_name||''} ${p.last_name||''}`.toLowerCase().includes(q)
        || (p.email||'').toLowerCase().includes(q);
    });
    investorPage = 1;
    selectedInvestors.clear();
    updateBulkBar();
    renderInvestorsTable();
  }, 250);

  search.addEventListener('input', filter);
  statusF.addEventListener('change', filter);
  kycF.addEventListener('change', filter);
  provF.addEventListener('change', filter);
  if (loginF)  loginF.addEventListener('change', filter);
  if (sortSel) sortSel.addEventListener('change', filter);

  // Apply saved filters immediately if any
  if (saved && (saved.q || saved.st || saved.ky || saved.pv || saved.lo || saved.so)) filter();
}

function viewSubAccount(saId) {
  const sa = (STATE.subAccounts || []).find(s => s.id === saId);
  if (!sa) return;
  const parent = STATE.investors.find(i => i.id === sa.parent_investor_id) || {};
  const parentName = `${parent.first_name || ''} ${parent.last_name || ''}`.trim() || sa.parent_investor_id || '—';
  const typeLabel  = (sa.type || 'standard').replace(/_/g, ' ');
  const typeCap    = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);
  const saRef      = sa.sa_reference || '—';
  const invCount   = (STATE.investments || []).filter(i => i.sub_account_id === sa.id).length;
  const activeInv  = (STATE.investments || []).filter(i => i.sub_account_id === sa.id && i.status === 'active').length;
  const totalInvested = (STATE.investments || []).filter(i => i.sub_account_id === sa.id)
    .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const ficaStatus = parent.fica_status || '';
  const _ficaNorm  = s => { const m = { Approved:'approved',Verified:'approved',Declined:'rejected',Unverified:'not_started',Outstanding:'pending',Pending:'pending' }; return m[s] || s; };
  const ficaNorm   = _ficaNorm(ficaStatus);
  const ficaColor  = ficaNorm === 'approved' || ficaNorm === 'verified' ? '#22c55e' : ficaNorm === 'rejected' || ficaNorm === 'flagged' ? '#ef4444' : ficaNorm === 'not_started' ? '#9ca3af' : '#f59e0b';
  const ficaIcon   = ficaNorm === 'approved' || ficaNorm === 'verified' ? 'fa-shield-check' : ficaNorm === 'flagged' ? 'fa-flag' : ficaNorm === 'not_started' ? 'fa-circle-xmark' : 'fa-clock';
  const _ficaDisplayLabel = s => ({ approved:'KYC Verified', verified:'KYC Verified', rejected:'Rejected', Declined:'Rejected', not_started:'No FICA Uploaded', Unverified:'No FICA Uploaded' })[s] || 'Pending Review';
  const bankStatus = sa.sa_bank_status || 'none';
  const bankColor  = bankStatus === 'approved' ? '#22c55e' : bankStatus === 'rejected' ? '#ef4444' : '#9ca3af';
  const bankLabel  = bankStatus === 'approved' ? 'Approved' : bankStatus === 'rejected' ? 'Rejected' : bankStatus === 'pending' ? 'Pending Review' : 'Not submitted';

  // KYC documents for this sub-account
  const saDocs = (STATE.kyc || []).filter(d => d.sub_account_id === sa.id)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const docTypeLabel = { id_document: 'ID Document', proof_of_address: 'Proof of Address', proof_of_bank: 'Bank Proof', proof_of_identity: 'Proof of Identity' };
  const saKycStatus  = sa.kyc_status || 'pending';
  const saKycColor   = saKycStatus === 'approved' ? '#22c55e' : '#f59e0b';
  const saKycIcon    = saKycStatus === 'approved' ? 'fa-circle-check' : 'fa-clock';

  document.getElementById('saModalSubtitle').textContent = saRef;
  document.getElementById('saModalBody').innerHTML = `
    <div class="info-list" style="margin-bottom:16px">
      <div class="info-row"><span class="info-row__label">Account Name</span><span class="info-row__value fw-700">${_esc(sa.name || '—')}</span></div>
      <div class="info-row"><span class="info-row__label">Account Number</span><span class="info-row__value" style="font-family:monospace;color:#ffe86a;font-weight:700">${saRef}</span></div>
      <div class="info-row"><span class="info-row__label">Account Type</span><span class="info-row__value">${typeCap}</span></div>
      <div class="info-row"><span class="info-row__label">Sub-Account FICA</span><span class="info-row__value" style="color:${saKycColor};font-weight:700"><i class="fa-solid ${saKycIcon}" style="margin-right:5px"></i>${saKycStatus.charAt(0).toUpperCase()+saKycStatus.slice(1)}</span></div>
      <div class="info-row"><span class="info-row__label">Parent FICA</span><span class="info-row__value" style="color:${ficaColor};font-weight:700"><i class="fa-solid ${ficaIcon}" style="margin-right:5px"></i>${_ficaDisplayLabel(ficaNorm)}</span></div>
      <div class="info-row"><span class="info-row__label">Bank Documents</span><span class="info-row__value" style="color:${bankColor};font-weight:700">${bankLabel}</span></div>
      <div class="info-row"><span class="info-row__label">Wallet Balance</span><span class="info-row__value td-gold fw-700">${Utils.rand(parseFloat(sa.wallet_balance)||0)}</span></div>
      <div class="info-row"><span class="info-row__label">Total Invested</span><span class="info-row__value fw-700">${Utils.rand(totalInvested)}</span></div>
      <div class="info-row"><span class="info-row__label">Investments</span><span class="info-row__value">${activeInv} active / ${invCount} total</span></div>
    </div>

    ${saDocs.length ? `
    <div style="background:var(--dark-3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:10px">
        <i class="fa-solid fa-id-card" style="color:#eda5ff;margin-right:6px"></i>Documents Submitted (${saDocs.length})
      </div>
      ${saDocs.map(d => {
        const dStatus = d.status || 'pending';
        const dColor = dStatus === 'approved' ? '#22c55e' : dStatus === 'rejected' ? '#ef4444' : '#f59e0b';
        const dIcon  = dStatus === 'approved' ? 'fa-circle-check' : dStatus === 'rejected' ? 'fa-circle-xmark' : 'fa-clock';
        const dDate  = d.created_at ? new Date(d.created_at).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
        const dLabel = docTypeLabel[d.doc_type] || d.doc_type || 'Document';
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:0.8rem">
          <div>
            <span style="font-weight:700;color:var(--text)">${_esc(dLabel)}</span>
            <span style="color:var(--text-muted);margin-left:8px;font-size:0.72rem">${dDate}</span>
            ${d.notes ? `<div style="color:var(--text-muted);font-size:0.7rem;margin-top:2px">${_esc(d.notes)}</div>` : ''}
          </div>
          <span style="color:${dColor};font-weight:700;white-space:nowrap;margin-left:8px"><i class="fa-solid ${dIcon}" style="margin-right:4px"></i>${dStatus.charAt(0).toUpperCase()+dStatus.slice(1)}</span>
        </div>`;
      }).join('')}
    </div>` : `
    <div style="background:var(--dark-3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:0.82rem;color:var(--text-muted)">
      <i class="fa-solid fa-id-card" style="margin-right:6px;color:#eda5ff"></i>No documents submitted yet for this sub-account.
    </div>`}

    <div style="background:var(--dark-3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)">Bank Details</div>
        <button class="btn btn--secondary btn--sm" style="padding:3px 10px;font-size:0.72rem" onclick='editSaBankDetails(${JSON.stringify(sa.id)})'><i class="fa-solid fa-pen-to-square" style="margin-right:4px"></i>Edit</button>
      </div>
      ${sa.sa_bank_holder ? `<div class="info-list">
        <div class="info-row"><span class="info-row__label">Account Holder</span><span class="info-row__value">${_esc(sa.sa_bank_holder||'—')}</span></div>
        <div class="info-row"><span class="info-row__label">Bank</span><span class="info-row__value">${_esc(sa.sa_bank_name||'—')}</span></div>
        <div class="info-row"><span class="info-row__label">Account Number</span><span class="info-row__value" style="font-family:monospace">${_esc(sa.sa_bank_number||'—')}</span></div>
        <div class="info-row"><span class="info-row__label">Account Type</span><span class="info-row__value">${_esc(sa.sa_bank_type||'—')}</span></div>
        ${sa.sa_bank_branch ? `<div class="info-row"><span class="info-row__label">Branch Code</span><span class="info-row__value" style="font-family:monospace">${_esc(sa.sa_bank_branch)}</span></div>` : ''}
        <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value" style="color:${bankColor};font-weight:700">${bankLabel}</span></div>
      </div>` : `<div style="font-size:0.8rem;color:var(--text-muted)"><i class="fa-solid fa-circle-info" style="margin-right:6px"></i>No banking details on file — click Edit to add.</div>`}
    </div>
    <div style="background:rgba(237,165,255,0.08);border:1px solid rgba(237,165,255,0.2);border-radius:10px;padding:12px 14px">
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:6px">Parent Account Holder</div>
      <div style="font-weight:700;font-size:0.88rem;margin-bottom:2px">${_esc(parentName)}</div>
      <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:10px">${_esc(parent.email||'')} · ${_esc(parent.id||'')}</div>
      <button class="btn btn--primary btn--sm" onclick="Modal.close('subAccountModal');viewInvestor('${sa.parent_investor_id}')"><i class="fa-solid fa-arrow-up-right-from-square" style="margin-right:6px"></i>View Parent Account</button>
    </div>`;
  Modal.open('subAccountModal');
}

function _invTab(name) {
  document.querySelectorAll('.inv-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[id^="invPanel-"]').forEach(p => { p.style.display = 'none'; });
  const btn = document.getElementById('invTab-' + name);
  const panel = document.getElementById('invPanel-' + name);
  if (btn) btn.classList.add('active');
  if (panel) panel.style.display = '';
}

let _currentInvestorId = null;

function _editInvProfile() {
  document.getElementById('invProfileView').style.display = 'none';
  document.getElementById('invProfileEdit').style.display = '';
}

function _cancelInvProfileEdit() {
  document.getElementById('invProfileEdit').style.display = 'none';
  document.getElementById('invProfileView').style.display = '';
}

async function _saveInvProfile(btn) {
  const inv = STATE.investors.find(i => i.id === _currentInvestorId);
  if (!inv) return;

  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    // Direct investor fields
    const directFields = {
      email:        document.getElementById('ipf-email').value.trim(),
      phone:        document.getElementById('ipf-phone').value.trim(),
      id_number:    document.getElementById('ipf-id_number').value.trim(),
      street_address: document.getElementById('ipf-street_address').value.trim() || null,
      suburb:         document.getElementById('ipf-suburb').value.trim() || null,
      address:        document.getElementById('ipf-address').value.trim(),
      postal_code:    document.getElementById('ipf-postal_code').value.trim() || null,
      province:       document.getElementById('ipf-province').value,
      occupation:   document.getElementById('ipf-occupation').value.trim(),
      risk_profile: document.getElementById('ipf-risk_profile').value,
    };

    // Merge JSONB profile fields, preserving existing keys
    let invProfile = {};
    try {
      if (inv.investor_profile) {
        invProfile = typeof inv.investor_profile === 'string'
          ? JSON.parse(inv.investor_profile)
          : { ...inv.investor_profile };
      }
    } catch (_) {}
    invProfile.employer     = document.getElementById('ipf-employer').value.trim();
    invProfile.next_of_kin  = document.getElementById('ipf-next_of_kin').value.trim();
    invProfile.kin_contact  = document.getElementById('ipf-kin_contact').value.trim();

    await API._fetch('PATCH', `tables/investors/${_currentInvestorId}`, {
      ...directFields,
      investor_profile: invProfile,
    });

    // Update local STATE so the read-only view refreshes correctly
    Object.assign(inv, directFields, { investor_profile: invProfile });

    Toast.show('Profile saved.', 'success');
    // Reload the investor detail to reflect updated data
    await viewInvestor(_currentInvestorId);
    _invTab('profile');
  } catch (err) {
    console.error('[saveInvProfile]', err);
    Toast.show('Failed to save: ' + (err.message || 'Unknown error'), 'error');
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function viewInvestor(id) {
  _currentInvestorId = id;
  const inv = STATE.investors.find(i => i.id === id);
  if (!inv) return;

  document.getElementById('invDetailTitle').textContent = `${inv.first_name} ${inv.last_name} — ${inv.id}`;
  document.getElementById('invDetailBody').innerHTML = '<div style="text-align:center;padding:48px"><i class="fa-solid fa-spinner fa-spin fa-2x" style="color:var(--text-muted)"></i></div>';
  Modal.open('investorDetailModal');

  let invsts = STATE.investments.filter(i => i.investor_id === id);
  let txns   = STATE.transactions.filter(t => t.investor_id === id);
  try {
    const [invstRes, txnRes] = await Promise.all([
      API._fetch('GET', 'tables/investments',  null, { investor_id: id, limit: 2000 }),
      API._fetch('GET', 'tables/transactions', null, { investor_id: id, limit: 2000 }),
    ]);
    if (invstRes?.data?.length) invsts = invstRes.data;
    if (txnRes?.data?.length)  txns   = txnRes.data;
  } catch (_) { /* fall back to STATE data already set above */ }

  // Check whether this investor has a login account (users row) and 2FA status
  let hasLoginAccount = null;
  let userRecord = null;
  try {
    const uRes = await API.list('users', { limit: 1, email: inv.email });
    userRecord = (uRes.data || [])[0] || null;
    hasLoginAccount = !!userRecord;
  } catch (_) { hasLoginAccount = null; }

  // Parse investor_profile JSONB for fields saved by quests
  let invProfile = {};
  try {
    if (inv.investor_profile) {
      invProfile = typeof inv.investor_profile === 'string'
        ? JSON.parse(inv.investor_profile)
        : inv.investor_profile;
    }
  } catch (_) {}

  /* Parse bank details stored in notes JSON by migration */
  let bankNotes = {};
  try { if (inv.notes && inv.notes.startsWith('{')) bankNotes = JSON.parse(inv.notes); } catch(_) {}
  const bankName   = inv.bank_name    || bankNotes.bank_name    || '—';
  const bankHolder = inv.bank_account_holder || bankNotes.account_holder || '—';
  const bankAcctRaw= inv.bank_account_number || bankNotes.account_number || '';
  const bankMasked = bankAcctRaw ? '••••' + String(bankAcctRaw).slice(-4) : '—';
  const bankBranch = inv.bank_branch_code || bankNotes.branch_code || '—';
  const bStatus    = inv.bank_account_status || (bankAcctRaw ? 'pending' : 'none');
  const bCls       = { none:'badge--grey', pending:'badge--yellow', approved:'badge--green', rejected:'badge--red' };
  const bLbl       = { none:'Not added', pending:'On file', approved:'Verified', rejected:'Rejected' };
  const avatarColor= _invAvatarColor(`${inv.first_name} ${inv.last_name}`);
  const totalInvested  = invsts.filter(i=>i.status==='active').reduce((s,i) => s+(parseFloat(i.amount)||0), 0);
  const activeInvCount = invsts.filter(i=>i.status==='active').length;
  const totalReturns   = invsts.filter(i=>['matured','paid_out'].includes(i.status)).reduce((s,i)=>s+(parseFloat(i.actual_return)||parseFloat(i.expected_return)||0), 0);
  const totalDeposits  = txns.filter(t=>t.type==='deposit' && t.status==='completed').reduce((s,t)=>s+(parseFloat(t.amount)||0), 0);
  const _stmtToday   = new Date().toISOString().slice(0, 10);
  const _stmtFromDef = _stmtToday.slice(0, 7) + '-01';

  document.getElementById('invDetailBody').innerHTML = `
  <div class="tab-bar" style="display:flex;gap:4px;padding:4px;border-radius:10px;margin-bottom:16px;flex-wrap:wrap">
    <button class="tab-btn inv-tab-btn active" id="invTab-overview"      onclick="_invTab('overview')"><i class="fa-solid fa-gauge-simple" style="margin-right:5px"></i>Overview</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-profile"       onclick="_invTab('profile')"><i class="fa-solid fa-address-card" style="margin-right:5px"></i>Profile</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-surveys"       onclick="_invTab('surveys')"><i class="fa-solid fa-clipboard-list" style="margin-right:5px"></i>Surveys</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-investments"   onclick="_invTab('investments')"><i class="fa-solid fa-chart-line" style="margin-right:5px"></i>Investments (${invsts.length})</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-transactions"  onclick="_invTab('transactions')"><i class="fa-solid fa-arrows-rotate" style="margin-right:5px"></i>Transactions</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-activity"      onclick="_invTab('activity');_loadInvestorActivity('${inv.id}')"><i class="fa-solid fa-mobile-screen" style="margin-right:5px"></i>Activity</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-admin"         onclick="_invTab('admin')"><i class="fa-solid fa-shield-halved" style="margin-right:5px"></i>Admin</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-statements"    onclick="_invTab('statements');_loadInvestorStatements('${inv.id}')"><i class="fa-solid fa-file-lines" style="margin-right:5px"></i>Statements</button>
    <button class="tab-btn inv-tab-btn"        id="invTab-comms"         onclick="_invTab('comms')"><i class="fa-solid fa-envelope" style="margin-right:5px"></i>Comms</button>
  </div>

  <!-- ── Overview ── -->
  <div id="invPanel-overview">
    <div class="flex-center gap-12 mb-16">
      <div style="width:52px;height:52px;border-radius:50%;background:${avatarColor};color:#fff;font-size:1rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${Utils.initials(inv.first_name + ' ' + inv.last_name)}</div>
      <div>
        <div style="font-size:1.15rem;font-weight:800;color:var(--text)">${_esc(inv.first_name)||''} ${_esc(inv.last_name)||''}</div>
        <div style="font-family:monospace;font-size:0.78rem;color:var(--text-muted);margin:2px 0">${_esc(inv.id)||''}<button class="copy-btn" onclick='copyToClipboard(${JSON.stringify(inv.id||"")},this)' title="Copy account number"><i class="fa-regular fa-copy"></i></button></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${Utils.statusBadge(inv.status)}
          ${inv.kyc_status==='approved'?'<span class="badge badge--green"><i class="fa-solid fa-shield-check"></i> KYC Verified</span>':'<span class="badge badge--yellow">KYC Pending</span>'}
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px">
      <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;text-align:center;position:relative" id="walletTile-${inv.id}">
        <div style="font-size:1.05rem;font-weight:800;color:#fec24f">${Utils.rand(inv.wallet_balance)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">Wallet</div>
        <button onclick="_quickEditWallet('${inv.id}')" title="Edit wallet balance" style="position:absolute;top:5px;right:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px;line-height:1;font-size:0.7rem;opacity:0.6" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6"><i class="fa-solid fa-pen"></i></button>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:1.05rem;font-weight:800;color:var(--text)">${Utils.rand(totalInvested)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">Active Invested</div>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:1.05rem;font-weight:800;color:#22c55e">${Utils.rand(totalReturns)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">Returns Earned</div>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:1.05rem;font-weight:800;color:#eda5ff">${Utils.rand(totalDeposits)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">Deposits</div>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:1.05rem;font-weight:800;color:#656565">${invsts.length}<span style="font-size:0.72rem;font-weight:400"> (${activeInvCount} active)</span></div>
        <div style="font-size:0.72rem;color:var(--text-muted)">Investments</div>
      </div>
    </div>
    <div class="panel mb-12">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-building-columns" style="color:var(--orange);margin-right:6px"></i>Bank Account</span></div>
      <div class="panel__body">
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Bank</span><span class="info-row__value">${bankName}</span></div>
          <div class="info-row"><span class="info-row__label">Account Holder</span><span class="info-row__value">${bankHolder}</span></div>
          <div class="info-row"><span class="info-row__label">Account No.</span><span class="info-row__value" style="font-family:monospace">${bankMasked}</span></div>
          <div class="info-row"><span class="info-row__label">Branch Code</span><span class="info-row__value">${bankBranch}</span></div>
          <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value"><span class="badge ${bCls[bStatus]}">${bLbl[bStatus]}</span></span></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="btn btn--secondary btn--sm" onclick='editBankDetails(${JSON.stringify(inv.id)})'><i class="fa-solid fa-pen-to-square"></i> Edit</button>
          ${bStatus!=='none'?`
            <button class="btn btn--secondary btn--sm" onclick='viewBankProof(${JSON.stringify(inv.id)})'><i class="fa-solid fa-arrow-up-right-from-square"></i> View Proof of Bank</button>
            ${bStatus==='pending'?`
              <button class="btn btn--success btn--sm" onclick='approveBankAccount(${JSON.stringify(inv.id)}, this)'><i class="fa-solid fa-check"></i> Approve</button>
              <button class="btn btn--danger btn--sm" onclick='rejectBankAccount(${JSON.stringify(inv.id)})'><i class="fa-solid fa-xmark"></i> Reject</button>
            `:''}
          `:''}
        </div>
      </div>
    </div>
    <div class="flex-between mt-16" style="flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--success btn--sm" onclick='depositToInvestor(${JSON.stringify(inv.id)}, ${JSON.stringify(inv.first_name + " " + inv.last_name)}, ${inv.wallet_balance || 0})'><i class="fa-solid fa-wallet"></i> Add Funds</button>
        <button class="btn btn--secondary btn--sm" onclick='approveInvestorFica(${JSON.stringify(inv.id)}, this)'><i class="fa-solid fa-id-card"></i> Approve FICA</button>
        ${hasLoginAccount === false ? `<button class="btn btn--secondary btn--sm" id="invInviteBtn" onclick='sendLoginInvite(${JSON.stringify(inv.id)}, ${JSON.stringify(inv.email)}, this)'><i class="fa-solid fa-envelope"></i> Send Login Invite</button>` : hasLoginAccount === true ? `<span class="badge badge--green" style="padding:6px 10px"><i class="fa-solid fa-circle-check"></i> Has login account</span>` : ''}
        ${userRecord?.totp_enabled ? `<button class="btn btn--sm" style="background:rgba(249,115,22,.15);color:#f97316;border:1px solid rgba(249,115,22,.3)" onclick='adminReset2FA(${JSON.stringify(userRecord.id)}, ${JSON.stringify(inv.first_name + " " + inv.last_name)}, this)'><i class="fa-solid fa-shield-xmark"></i> Reset 2FA</button>` : ''}
        ${inv.status === 'archived'
          ? `<button class="btn btn--sm" style="background:rgba(253,186,116,.15);color:#fb923c;border:1px solid rgba(253,186,116,.3)" onclick='unarchiveInvestor(${JSON.stringify(inv.id)}, this)'><i class="fa-solid fa-box-open"></i> Unarchive</button>`
          : `<button class="btn btn--sm" style="background:rgba(156,163,175,.1);color:var(--text-muted);border:1px solid rgba(156,163,175,.2)" onclick='confirmArchiveInvestor(${JSON.stringify(inv.id)}, this)'><i class="fa-solid fa-box-archive"></i> Archive</button>`}
        <button class="btn btn--sm" style="background:rgba(237,165,255,.1);color:#eda5ff;border:1px solid rgba(237,165,255,.25)" onclick='viewAsInvestor(${JSON.stringify(inv.id)})'><i class="fa-solid fa-eye"></i> View as Investor</button>
        <button class="btn btn--sm" style="background:rgba(59,130,246,.1);color:#60a5fa;border:1px solid rgba(59,130,246,.25)" onclick='_invTab("comms")'><i class="fa-solid fa-envelope"></i> Send Email</button>
      </div>
      <button class="btn btn--primary btn--sm" onclick='Modal.close("investorDetailModal")'><i class="fa-solid fa-check"></i> Done</button>
    </div>
  </div>

  <!-- ── Profile ── -->
  <div id="invPanel-profile" style="display:none">
    <!-- read-only view -->
    <div id="invProfileView">
      <div class="info-list">
        <div class="info-row"><span class="info-row__label">Email</span><span class="info-row__value">${_esc(inv.email)||'—'}${inv.email?`<button class="copy-btn" onclick='copyToClipboard(${JSON.stringify(inv.email)},this)' title="Copy email"><i class="fa-regular fa-copy"></i></button>`:''}</span></div>
        <div class="info-row"><span class="info-row__label">Phone</span><span class="info-row__value">${_esc(inv.phone)||'—'}${inv.phone?`<button class="copy-btn" onclick='copyToClipboard(${JSON.stringify(inv.phone)},this)' title="Copy phone"><i class="fa-regular fa-copy"></i></button>`:''}</span></div>
        <div class="info-row"><span class="info-row__label">SA ID Number</span><span class="info-row__value">${_esc(inv.id_number)||'—'}${inv.id_number?`<button class="copy-btn" onclick='copyToClipboard(${JSON.stringify(inv.id_number)},this)' title="Copy ID"><i class="fa-regular fa-copy"></i></button>`:''}</span></div>
        ${inv.street_address ? `<div class="info-row"><span class="info-row__label">Street Address</span><span class="info-row__value" style="font-size:0.78rem">${_esc(inv.street_address)}</span></div>` : ''}
        ${inv.suburb ? `<div class="info-row"><span class="info-row__label">Suburb</span><span class="info-row__value">${_esc(inv.suburb)}</span></div>` : ''}
        <div class="info-row"><span class="info-row__label">City</span><span class="info-row__value">${_esc(inv.address)||'—'}</span></div>
        ${inv.postal_code ? `<div class="info-row"><span class="info-row__label">Postal Code</span><span class="info-row__value">${_esc(inv.postal_code)}</span></div>` : ''}
        <div class="info-row"><span class="info-row__label">Province</span><span class="info-row__value">${_esc((inv.province||'').trim())||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Occupation</span><span class="info-row__value">${_esc(inv.occupation)||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Employer</span><span class="info-row__value">${_esc(invProfile.employer||'')||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Next of Kin</span><span class="info-row__value">${_esc(invProfile.next_of_kin||'')||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Kin Contact</span><span class="info-row__value">${_esc(invProfile.kin_contact||'')||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Risk Profile</span><span class="info-row__value" style="text-transform:capitalize">${_esc(inv.risk_profile)||'—'}</span></div>
        <div class="info-row"><span class="info-row__label">Account Created</span><span class="info-row__value">${Utils.date(inv.date_joined)}</span></div>
      </div>
      <div style="margin-top:14px">
        <button class="btn btn--secondary btn--sm" onclick="_editInvProfile()"><i class="fa-solid fa-pen-to-square"></i> Edit Profile</button>
      </div>
    </div>
    <!-- edit form (hidden initially) -->
    <div id="invProfileEdit" style="display:none">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" class="form-control" id="ipf-email" value="${_esc(inv.email||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Phone</label>
          <input type="text" class="form-control" id="ipf-phone" value="${_esc(inv.phone||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">SA ID Number</label>
          <input type="text" class="form-control" id="ipf-id_number" value="${_esc(inv.id_number||'')}">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Street Address</label>
          <input type="text" class="form-control" id="ipf-street_address" value="${_esc(inv.street_address||'')}" placeholder="e.g. 10 Main Road">
        </div>
        <div class="form-group">
          <label class="form-label">Suburb</label>
          <input type="text" class="form-control" id="ipf-suburb" value="${_esc(inv.suburb||'')}" placeholder="e.g. Sandton">
        </div>
        <div class="form-group">
          <label class="form-label">City</label>
          <input type="text" class="form-control" id="ipf-address" value="${_esc(inv.address||'')}" placeholder="e.g. Johannesburg">
        </div>
        <div class="form-group">
          <label class="form-label">Postal Code</label>
          <input type="text" class="form-control" id="ipf-postal_code" value="${_esc(inv.postal_code||'')}" placeholder="e.g. 2196">
        </div>
        <div class="form-group">
          <label class="form-label">Province</label>
          <select class="form-control" id="ipf-province">
            ${['','Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','Northern Cape','North West','Western Cape'].map(p=>`<option value="${p}" ${(inv.province||'').trim()===p?'selected':''}>${p||'— Select province —'}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Occupation</label>
          <input type="text" class="form-control" id="ipf-occupation" value="${_esc(inv.occupation||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Employer</label>
          <input type="text" class="form-control" id="ipf-employer" value="${_esc(invProfile.employer||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Next of Kin</label>
          <input type="text" class="form-control" id="ipf-next_of_kin" value="${_esc(invProfile.next_of_kin||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Kin Contact</label>
          <input type="text" class="form-control" id="ipf-kin_contact" value="${_esc(invProfile.kin_contact||'')}">
        </div>
        <div class="form-group">
          <label class="form-label">Risk Profile</label>
          <select class="form-control" id="ipf-risk_profile">
            ${['','conservative','moderate','aggressive'].map(r=>`<option value="${r}" ${(inv.risk_profile||'')===r?'selected':''}>${r||'— Select —'}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn--primary btn--sm" onclick="_saveInvProfile(this)"><i class="fa-solid fa-floppy-disk"></i> Save Changes</button>
        <button class="btn btn--secondary btn--sm" onclick="_cancelInvProfileEdit()"><i class="fa-solid fa-xmark"></i> Cancel</button>
      </div>
    </div>
  </div>

  <!-- ── Surveys ── -->
  <div id="invPanel-surveys" style="display:none">
    ${(invProfile.investment_goal || invProfile.risk_reaction || invProfile.time_horizon || invProfile.savings_pct || invProfile.return_preference) ? `
    <div class="panel mb-12">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-shield-halved" style="color:#eda5ff;margin-right:6px"></i>Know Your Risk Profile</span></div>
      <div class="panel__body">
        <div class="info-list">
          ${invProfile.investment_goal   ? `<div class="info-row"><span class="info-row__label">Investment Goal</span><span class="info-row__value">${_esc(invProfile.investment_goal)}</span></div>` : ''}
          ${invProfile.risk_reaction     ? `<div class="info-row"><span class="info-row__label">Risk Reaction</span><span class="info-row__value">${_esc(invProfile.risk_reaction)}</span></div>` : ''}
          ${invProfile.time_horizon      ? `<div class="info-row"><span class="info-row__label">Time Horizon</span><span class="info-row__value">${_esc(invProfile.time_horizon)}</span></div>` : ''}
          ${invProfile.savings_pct       ? `<div class="info-row"><span class="info-row__label">Savings % at SVC</span><span class="info-row__value">${_esc(invProfile.savings_pct)}</span></div>` : ''}
          ${invProfile.return_preference ? `<div class="info-row"><span class="info-row__label">Return Preference</span><span class="info-row__value">${_esc(invProfile.return_preference)}</span></div>` : ''}
        </div>
      </div>
    </div>` : ''}
    ${(invProfile.saving_for || invProfile.income_need || invProfile.liquidity || invProfile.product_interest) ? `
    <div class="panel mb-12">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-crosshairs" style="color:#fec24f;margin-right:6px"></i>Investment Goals</span></div>
      <div class="panel__body">
        <div class="info-list">
          ${invProfile.saving_for       ? `<div class="info-row"><span class="info-row__label">Saving For</span><span class="info-row__value">${_esc(invProfile.saving_for)}</span></div>` : ''}
          ${invProfile.income_need      ? `<div class="info-row"><span class="info-row__label">Income Need</span><span class="info-row__value">${_esc(invProfile.income_need)}</span></div>` : ''}
          ${invProfile.liquidity        ? `<div class="info-row"><span class="info-row__label">Liquidity</span><span class="info-row__value">${_esc(invProfile.liquidity)}</span></div>` : ''}
          ${invProfile.product_interest ? `<div class="info-row"><span class="info-row__label">Product Interest</span><span class="info-row__value">${_esc(invProfile.product_interest)}</span></div>` : ''}
        </div>
      </div>
    </div>` : ''}
    ${(invProfile.employment_status || invProfile.income_bracket || invProfile.dependents || invProfile.investment_experience || invProfile.heard_via) ? `
    <div class="panel mb-12">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-briefcase" style="color:#fec24f;margin-right:6px"></i>Financial Background</span></div>
      <div class="panel__body">
        <div class="info-list">
          ${invProfile.employment_status     ? `<div class="info-row"><span class="info-row__label">Employment</span><span class="info-row__value">${_esc(invProfile.employment_status)}</span></div>` : ''}
          ${invProfile.income_bracket        ? `<div class="info-row"><span class="info-row__label">Income Bracket</span><span class="info-row__value">${_esc(invProfile.income_bracket)}</span></div>` : ''}
          ${invProfile.dependents            ? `<div class="info-row"><span class="info-row__label">Dependents</span><span class="info-row__value">${_esc(invProfile.dependents)}</span></div>` : ''}
          ${invProfile.investment_experience ? `<div class="info-row"><span class="info-row__label">Experience</span><span class="info-row__value">${_esc(invProfile.investment_experience)}</span></div>` : ''}
          ${invProfile.heard_via             ? `<div class="info-row"><span class="info-row__label">Heard Via</span><span class="info-row__value">${_esc(invProfile.heard_via)}</span></div>` : ''}
        </div>
      </div>
    </div>` : ''}
    ${!(invProfile.investment_goal || invProfile.risk_reaction || invProfile.time_horizon || invProfile.savings_pct || invProfile.return_preference || invProfile.saving_for || invProfile.income_need || invProfile.liquidity || invProfile.product_interest || invProfile.employment_status || invProfile.income_bracket || invProfile.dependents || invProfile.investment_experience || invProfile.heard_via) ? `
    <div style="text-align:center;padding:40px 16px;color:var(--text-muted);font-size:0.85rem">
      <i class="fa-solid fa-clipboard-list" style="font-size:2rem;margin-bottom:10px;display:block;opacity:0.3"></i>
      No survey responses yet. This client hasn't completed any profile quests.
    </div>` : ''}
  </div>

  <!-- ── Investments ── -->
  <div id="invPanel-investments" style="display:none">
    <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px">${invsts.length} investment${invsts.length!==1?'s':''} · ${Utils.rand(invsts.filter(i=>i.status==='active').reduce((s,i)=>s+(parseFloat(i.amount)||0),0))} active capital</div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto">
      <table class="data-table mb-16">
        <thead style="position:sticky;top:0;z-index:1"><tr><th style="min-width:160px">Pool</th><th style="min-width:130px">Product</th><th>Date Invested</th><th>Amount</th><th>Rate</th><th>Status</th><th>Maturity</th><th></th></tr></thead>
        <tbody>${invsts.length ? invsts.map(i => {
          const pi = Utils.productInfo(i.product_type);
          return `<tr>
            <td class="td-strong" title="${_esc(i.pool_name||'')}">${_esc(i.pool_name)||'—'}</td>
            <td title="${_esc(pi.label)}"><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
            <td class="td-muted">${Utils.date(i.start_date||i.created_at)}</td>
            <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
            <td class="td-green">${i.annual_rate?Utils.pct(i.annual_rate):'—'}</td>
            <td>${Utils.statusBadge(i.status)}</td>
            <td class="td-muted">${Utils.date(i.end_date)}</td>
            <td><button class="btn btn--sm" style="background:rgba(237,165,255,.1);color:#eda5ff;border:1px solid rgba(237,165,255,.25)" onclick='openMoveInvestment(${JSON.stringify(i.id)},${JSON.stringify(i.pool_id)})' title="Move to different pool"><i class="fa-solid fa-right-left"></i></button></td>
          </tr>`;
        }).join(''):'<tr><td colspan="8" class="text-center text-muted" style="padding:16px">No investments on record</td></tr>'}</tbody>
      </table>
    </div>
    <!-- ── Create Investment on Behalf ── -->
    <div class="panel mt-16" style="border-color:rgba(34,197,94,0.25)" id="adminInvestPanel-${inv.id}">
      <div class="panel__header" style="background:rgba(34,197,94,0.06)">
        <span class="panel__title"><i class="fa-solid fa-arrow-trend-up" style="color:#22c55e;margin-right:6px"></i>Create Investment on Behalf</span>
        <span style="font-size:0.72rem;color:#22c55e;font-weight:600">Admin Action</span>
      </div>
      <div class="panel__body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label style="font-size:0.78rem;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px">Investment Pool</label>
            <select id="adminInvestPool-${inv.id}" style="width:100%;padding:8px 10px;border:1.5px solid rgba(0,0,0,0.12);border-radius:8px;font-size:0.85rem;background:var(--bg-secondary);color:var(--text)">
              <option value="">— Select pool —</option>
              ${(STATE.pools||[]).filter(p=>['open','active','filling'].includes(p.status)).sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>`<option value="${_esc(p.id)}">${_esc(p.name)} (min: ${Utils.rand(p.min_investment||0)}, ${Utils.pct(p.annual_rate||0)} p.a.)</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:0.78rem;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px">Amount (R)</label>
            <input type="number" id="adminInvestAmt-${inv.id}" min="0" step="0.01" placeholder="e.g. 5000" style="width:100%;padding:8px 10px;border:1.5px solid rgba(0,0,0,0.12);border-radius:8px;font-size:0.85rem;background:var(--bg-secondary);color:var(--text);box-sizing:border-box" />
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.85rem;font-weight:600">
            <input type="checkbox" id="adminInvestFee-${inv.id}" style="width:16px;height:16px;accent-color:#22c55e" />
            Charge 1% platform fee
          </label>
          <span style="font-size:0.78rem;color:var(--text-muted)">· Wallet: <strong>${Utils.rand(inv.wallet_balance)}</strong></span>
        </div>
        <div id="adminInvestResult-${inv.id}" style="font-size:0.82rem;margin-bottom:10px"></div>
        <button class="btn btn--success btn--sm" onclick='adminInvestOnBehalf(${JSON.stringify(inv.id)},${JSON.stringify(inv.first_name+" "+inv.last_name)},this)'>
          <i class="fa-solid fa-arrow-trend-up"></i> Create Investment
        </button>
      </div>
    </div>
  </div>

  <!-- ── Transactions ── -->
  <div id="invPanel-transactions" style="display:none">
    <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px">${txns.length} transaction${txns.length!==1?'s':''}</div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto">
      <table class="data-table mb-16">
        <thead style="position:sticky;top:0;z-index:1"><tr><th>Type</th><th>Amount</th><th>Status</th><th>Reference</th><th>Description</th><th>Date</th></tr></thead>
        <tbody>${txns.length ? txns.map(t => `
          <tr>
            <td>${Utils.statusBadge(t.type)}</td>
            <td class="${(parseFloat(t.amount)||0)<0?'td-red':'td-green'} fw-700">${(parseFloat(t.amount)||0)<0?'':'+'}${Utils.rand(t.amount)}</td>
            <td>${Utils.statusBadge(t.status)}</td>
            <td class="td-muted" style="font-size:0.78rem;font-family:monospace">${_esc(t.reference)||'—'}</td>
            <td class="td-muted" style="font-size:0.78rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(t.description||t.notes)||'—'}</td>
            <td class="td-muted">${Utils.date(t.transaction_date||t.created_at)}</td>
          </tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted" style="padding:16px">No transactions on record</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <!-- ── Admin ── -->
  <div id="invPanel-admin" style="display:none">
    <div class="panel mb-16" style="border-color:rgba(254,194,79,0.25)">
      <div class="panel__header" style="background:rgba(254,194,79,0.06)">
        <span class="panel__title"><i class="fa-solid fa-wallet" style="color:#fec24f;margin-right:6px"></i>Wallet Maintenance</span>
      </div>
      <div class="panel__body" style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div style="font-size:0.83rem;font-weight:600;color:var(--text);margin-bottom:4px">Restore Wallet After Re-import</div>
          <div style="font-size:0.77rem;color:var(--text-muted)">Sets wallet balance to the sum of admin-created manual deposits (ADMIN-DEP-* transactions only). Use this if a data migration overwrote the live balance — historical Firebase transactions are intentionally excluded to avoid double-counting.</div>
        </div>
        <button class="btn btn--warning btn--sm" style="flex-shrink:0" onclick='_recalcInvestorWallet(${JSON.stringify(inv.id)},${JSON.stringify(inv.first_name + " " + inv.last_name)},this)'>
          <i class="fa-solid fa-calculator"></i> Recalculate Wallet
        </button>
      </div>
    </div>
    <div class="panel mb-16" style="border-color:rgba(96,165,250,0.25)">
      <div class="panel__header" style="background:rgba(96,165,250,0.06)">
        <span class="panel__title"><i class="fa-solid fa-scale-balanced" style="color:#60a5fa;margin-right:6px"></i>Wallet Reconciliation</span>
      </div>
      <div class="panel__body" style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <div style="font-size:0.83rem;font-weight:600;color:var(--text);margin-bottom:4px">Reconcile from All Transactions</div>
          <div style="font-size:0.77rem;color:var(--text-muted)">Recomputes wallet balance from all completed deposits, returns and payouts minus withdrawals and fees. Use when a deposit shows as completed but is not reflected in the wallet balance.</div>
          <div id="invReconcileResult-${inv.id}" style="margin-top:8px;font-size:0.77rem"></div>
        </div>
        <button class="btn btn--sm" style="flex-shrink:0;background:rgba(96,165,250,.12);color:#60a5fa;border:1px solid rgba(96,165,250,.3)" onclick='reconcileInvestorWallet(${JSON.stringify(inv.id)},this)'>
          <i class="fa-solid fa-scale-balanced"></i> Reconcile Wallet
        </button>
      </div>
    </div>
    <div class="panel mb-16" style="border-color:rgba(239,68,68,0.25)">
      <div class="panel__header" style="background:rgba(239,68,68,0.06)">
        <span class="panel__title"><i class="fa-solid fa-pen-to-square" style="color:#f87171;margin-right:6px"></i>Direct Balance Override</span>
        <span style="font-size:0.72rem;color:#f87171;font-weight:600">Admin Fix</span>
      </div>
      <div class="panel__body">
        <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px">Set the wallet balance directly without creating a transaction record. Use only when the balance cannot be corrected via reconciliation.</div>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:140px">
            <label style="font-size:0.77rem;font-weight:600;color:var(--text);display:block;margin-bottom:4px">New Balance (R)</label>
            <input type="number" id="walletOverrideAmt-${inv.id}" class="form-input" min="0" step="0.01" placeholder="0.00" style="width:100%" value="${parseFloat(inv.wallet_balance)||0}">
          </div>
          <div style="flex:2;min-width:180px">
            <label style="font-size:0.77rem;font-weight:600;color:var(--text);display:block;margin-bottom:4px">Reason (optional)</label>
            <input type="text" id="walletOverrideNotes-${inv.id}" class="form-input" placeholder="e.g. correcting reconciliation error" style="width:100%">
          </div>
          <button class="btn btn--sm" style="flex-shrink:0;background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.3)" onclick='overrideWalletBalance(${JSON.stringify(inv.id)},${JSON.stringify(inv.first_name+' '+inv.last_name)},this)'>
            <i class="fa-solid fa-pen-to-square"></i> Set Balance
          </button>
        </div>
        <div id="walletOverrideResult-${inv.id}" style="margin-top:8px;font-size:0.77rem"></div>
      </div>
    </div>
    <div class="panel mb-16">
      <div class="panel__header">
        <span class="panel__title">Notes History</span>
        <span style="font-size:0.72rem;color:var(--text-dim)" id="invNotesCount">Loading…</span>
      </div>
      <div class="panel__body" id="invNotesList" style="max-height:200px;overflow-y:auto">
        <div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading notes…</div>
      </div>
      <div class="panel__body" style="border-top:1px solid var(--border);padding-top:12px">
        <textarea class="form-input" id="invNewNoteTA" style="width:100%;min-height:70px;font-size:0.82rem;resize:vertical;margin-bottom:8px" placeholder="Add a note visible only to admins…"></textarea>
        <button class="btn btn--primary btn--sm" onclick='addInvestorNote(${JSON.stringify(inv.id)})'><i class="fa-solid fa-plus"></i> Add Note</button>
      </div>
    </div>
    <div class="panel mb-16">
      <div class="panel__header"><span class="panel__title">Activity Timeline</span></div>
      <div class="panel__body" style="padding:0 4px">
        <div id="investorTimeline" style="max-height:320px;overflow-y:auto;padding:4px 0">
          <div style="text-align:center;padding:16px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>
        </div>
      </div>
    </div>
  </div>

  <div id="invPanel-activity" style="display:none">
    <div class="panel mb-16">
      <div class="panel__header"><span class="panel__title">Account Access</span></div>
      <div class="panel__body" id="invActivity-access">
        <div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>
      </div>
    </div>
    <div class="panel mb-16">
      <div class="panel__header">
        <span class="panel__title">Mobile App &amp; Devices</span>
        <span style="font-size:0.72rem;color:var(--text-dim)" id="invActivity-deviceCount"></span>
      </div>
      <div class="panel__body" id="invActivity-devices">
        <div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>
      </div>
    </div>
    <div class="panel mb-16">
      <div class="panel__header">
        <span class="panel__title">Active Sessions</span>
        <span style="font-size:0.72rem;color:var(--text-dim)" id="invActivity-sessionCount"></span>
      </div>
      <div class="panel__body" id="invActivity-sessions">
        <div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>
      </div>
    </div>
  </div>

  <!-- ── Statements ── -->
  <div id="invPanel-statements" style="display:none">
    <!-- Account Statement -->
    <div class="panel mb-16">
      <div class="panel__header">
        <span class="panel__title"><i class="fa-solid fa-file-lines" style="color:#eda5ff;margin-right:6px"></i>Account Statement</span>
      </div>
      <div class="panel__body">
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px">Generate a full account statement for any date range — shows all transactions, a running wallet balance, and the active investment portfolio.</p>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-group" style="margin:0;flex:1;min-width:140px">
            <label class="form-label">From</label>
            <input type="date" class="form-control" id="stmtFromDate" value="${_stmtFromDef}">
          </div>
          <div class="form-group" style="margin:0;flex:1;min-width:140px">
            <label class="form-label">To</label>
            <input type="date" class="form-control" id="stmtToDate" value="${_stmtToday}">
          </div>
          <button class="btn btn--primary btn--sm" id="stmtGenBtn" onclick="_generateAccountStatement('${inv.id}')">
            <i class="fa-solid fa-file-lines"></i> Generate Statement
          </button>
        </div>
      </div>
    </div>
    <!-- Tax Certificate -->
    <div class="panel mb-16">
      <div class="panel__header">
        <span class="panel__title"><i class="fa-solid fa-file-invoice" style="color:#22c55e;margin-right:6px"></i>Investment Income Reference</span>
      </div>
      <div class="panel__body">
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px">Generate an investment income reference for the client showing returns earned and deposits made in the selected SA tax year (1 March – last day of February).</p>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="form-group" style="margin:0;flex:1;min-width:180px">
            <label class="form-label">Tax Year (ending February)</label>
            <select class="form-control" id="adminTaxCertYear">
              ${[new Date().getFullYear(), new Date().getFullYear()-1, new Date().getFullYear()-2, new Date().getFullYear()-3].map(y => `<option value="${y}">${y-1} / ${y}</option>`).join('')}
            </select>
          </div>
          <button class="btn btn--primary btn--sm" id="adminTaxCertBtn" onclick="_generateAdminTaxCert('${inv.id}')">
            <i class="fa-solid fa-file-invoice"></i> Generate Certificate
          </button>
        </div>
      </div>
    </div>
    <!-- Monthly statements list -->
    <div id="invStatementsList"><div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div></div>
  </div>

  <!-- ── Comms ── -->
  <div id="invPanel-comms" style="display:none">
    <div class="panel mb-16">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-paper-plane" style="color:#60a5fa;margin-right:6px"></i>Send Email to Investor</span></div>
      <div class="panel__body">
        <div class="form-group mb-10">
          <label class="form-label">Subject *</label>
          <input type="text" class="form-input" id="invEmailSubject" placeholder="e.g. Your investment update">
        </div>
        <div class="form-group mb-12">
          <label class="form-label">Message *</label>
          <textarea class="form-input" id="invEmailMessage" style="min-height:140px;resize:vertical" placeholder="Type your message to ${_esc(inv.first_name)}…"></textarea>
        </div>
        <button class="btn btn--primary" onclick='sendInvestorEmail(${JSON.stringify(inv.id)},${JSON.stringify(inv.email)},this)'><i class="fa-solid fa-paper-plane"></i> Send Email</button>
      </div>
    </div>
  </div>
  `;
  // Modal already opened above while data was loading
  const ta = document.getElementById('invNewNoteTA');
  if (ta) ta.value = inv.notes || '';
  loadInvestorNotes(inv.id);
  loadInvestorTimeline(inv, invsts, txns);
}

async function depositToInvestor(investorId, investorName, currentBalance) {
  const amtStr = prompt(`Add funds to ${investorName}'s wallet.\nCurrent balance: ${Utils.rand(currentBalance)}\n\nEnter amount (R):`);
  if (!amtStr) return;
  const amount = parseFloat(amtStr);
  if (!amount || amount <= 0) { Toast.error('Invalid amount'); return; }
  try {
    // Creating a completed deposit transaction triggers the server-side wallet
    // credit hook atomically — do NOT also update wallet_balance directly or
    // the balance is credited twice.
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: investorId,
      type:        'deposit',
      amount,
      status:      'completed',
      reference:   `ADMIN-DEP-${Date.now()}`,
      description: `Admin manual deposit — wallet top-up for ${investorName}`,
    });
    Toast.success(`${Utils.rand(amount)} added to ${investorName}'s wallet`);
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to add funds'); }
}

async function _recalcInvestorWallet(investorId, investorName, btn) {
  if (!await Confirm.ask('Recalculate Wallet Balance?', {
    body: `This will recompute ${investorName}'s wallet balance from all completed transactions (deposits, returns, payouts minus withdrawals and fees). The current balance will be overwritten. This cannot be undone.`,
    confirmLabel: 'Recalculate',
  })) return;
  await _withBtn(btn, async () => {
    try {
      const res = await API._fetch('POST', `admin/recalculate-wallet/${investorId}`);
      const newBal = Utils.rand(res.new_balance);
      Toast.success(`Wallet recalculated — new balance: ${newBal}`);
      const inv = STATE.investors.find(i => i.id === investorId);
      if (inv) inv.wallet_balance = res.new_balance;
      Modal.close('investorDetailModal');
      await loadInvestors();
    } catch (e) { Toast.error('Recalculation failed: ' + (e.message || 'unknown error')); }
  });
}

async function reconcileInvestorWallet(investorId, btn) {
  await _withBtn(btn, async () => {
    try {
      const resultEl = document.getElementById(`invReconcileResult-${investorId}`);
      // Dry-run first to show what would change
      const preview = await API._fetch('POST', 'admin/reconcile-wallet', { investor_id: investorId, dry_run: true });
      if (!preview.diffs || !preview.diffs[0]) {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--text-muted)">No transactions found.</span>`;
        Toast.info('No completed transactions found to reconcile.');
        return;
      }
      const d = preview.diffs[0];
      if (Math.abs(d.diff) < 0.01) {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--green)"><i class="fa-solid fa-check"></i> Wallet is correct (${Utils.rand(d.current)})</span>`;
        Toast.info('Wallet balance is already correct — no change needed.');
        return;
      }
      const confirmed = await Confirm.ask('Reconcile wallet balance?', {
        body: `Current: ${Utils.rand(d.current)} → Computed from transactions: ${Utils.rand(d.computed)} (${d.diff > 0 ? '+' : ''}${Utils.rand(d.diff)}). This will overwrite the current balance.`,
        confirmLabel: 'Apply',
        danger: d.computed < 0,
      });
      if (!confirmed) return;
      await API._fetch('POST', 'admin/reconcile-wallet', { investor_id: investorId });
      if (resultEl) resultEl.innerHTML = `<span style="color:#fec24f"><i class="fa-solid fa-check"></i> Adjusted ${d.diff > 0 ? '+' : ''}${Utils.rand(d.diff)} → ${Utils.rand(d.computed)}</span>`;
      Toast.success(`Wallet reconciled. New balance: ${Utils.rand(d.computed)}`);
      const inv = STATE.investors.find(i => i.id === investorId);
      if (inv) inv.wallet_balance = d.computed;
    } catch (e) { Toast.error('Reconciliation failed: ' + (e.message || 'unknown error')); }
  });
}

async function _quickEditWallet(investorId) {
  const inv = STATE.investors.find(i => i.id === investorId);
  if (!inv) return;
  const tile = document.getElementById('walletTile-' + investorId);
  if (!tile) return;
  const oldBal = parseFloat(inv.wallet_balance) || 0;
  tile.innerHTML = `
    <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px">Set wallet balance</div>
    <input id="qwEdit-${investorId}" type="number" min="0" step="0.01" value="${oldBal}"
      style="width:100%;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.85rem;text-align:center;margin-bottom:6px">
    <div style="display:flex;gap:4px;justify-content:center">
      <button onclick="_quickEditWalletSave('${investorId}')" class="btn btn--success btn--sm" style="padding:3px 10px;font-size:0.72rem">Save</button>
      <button onclick="_quickEditWalletCancel('${investorId}', ${oldBal})" class="btn btn--secondary btn--sm" style="padding:3px 8px;font-size:0.72rem">Cancel</button>
    </div>`;
  tile.querySelector('input')?.select();
}

function _quickEditWalletCancel(investorId, oldBal) {
  const inv = STATE.investors.find(i => i.id === investorId);
  const tile = document.getElementById('walletTile-' + investorId);
  if (!tile) return;
  tile.innerHTML = `
    <div style="font-size:1.05rem;font-weight:800;color:#fec24f">${Utils.rand(inv?.wallet_balance ?? oldBal)}</div>
    <div style="font-size:0.72rem;color:var(--text-muted)">Wallet</div>
    <button onclick="_quickEditWallet('${investorId}')" title="Edit wallet balance" style="position:absolute;top:5px;right:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px;line-height:1;font-size:0.7rem;opacity:0.6" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6"><i class="fa-solid fa-pen"></i></button>`;
}

async function _quickEditWalletSave(investorId) {
  const inv   = STATE.investors.find(i => i.id === investorId);
  const input = document.getElementById('qwEdit-' + investorId);
  if (!inv || !input) return;
  const nb     = parseFloat(input.value);
  const oldBal = parseFloat(inv.wallet_balance) || 0;
  if (isNaN(nb) || nb < 0) { Toast.error('Enter a valid amount'); return; }
  const diff    = Math.round((nb - oldBal) * 100) / 100;
  const diffStr = diff >= 0 ? `+${Utils.rand(diff)}` : `-${Utils.rand(Math.abs(diff))}`;
  const name    = `${inv.first_name} ${inv.last_name}`;
  const confirmed = await Confirm.ask('Set wallet balance?', {
    body: `Investor: ${name}\nCurrent: ${Utils.rand(oldBal)} → New: ${Utils.rand(nb)} (${diffStr})\n\nNo transaction record will be created.`,
    confirmLabel: 'Set Balance',
    danger: nb < oldBal,
  });
  if (!confirmed) return;
  try {
    const res = await API._fetch('POST', 'admin/override-wallet', { investorId, newBalance: nb, notes: 'Quick edit from profile tile' });
    if (res.success) {
      inv.wallet_balance = nb;
      Toast.success(`Wallet set to ${Utils.rand(nb)}`);
    } else {
      Toast.error(res.error || 'Override failed');
    }
  } catch (e) {
    Toast.error('Override failed: ' + (e.message || 'unknown error'));
  }
  _quickEditWalletCancel(investorId, nb);
}

async function overrideWalletBalance(investorId, name, btn) {
  const amtEl    = document.getElementById('walletOverrideAmt-' + investorId);
  const notesEl  = document.getElementById('walletOverrideNotes-' + investorId);
  const resultEl = document.getElementById('walletOverrideResult-' + investorId);
  const nb = parseFloat(amtEl.value);
  if (isNaN(nb) || nb < 0) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#f87171">Enter a valid amount (0 or more).</span>';
    return;
  }
  const inv = STATE.investors.find(i => i.id === investorId);
  const oldBal = parseFloat(inv?.wallet_balance) || 0;
  const diff   = Math.round((nb - oldBal) * 100) / 100;
  const diffStr = diff >= 0 ? `+${Utils.rand(diff)}` : `-${Utils.rand(Math.abs(diff))}`;

  const confirmed = await Confirm.ask('Set wallet balance?', {
    body: `Investor: ${name}\nCurrent: ${Utils.rand(oldBal)} → New: ${Utils.rand(nb)} (${diffStr})\n\nNo transaction record will be created. This action is logged.`,
    confirmLabel: 'Set Balance',
    danger: nb < oldBal,
  });
  if (!confirmed) return;

  await _withBtn(btn, async () => {
    try {
      const res = await API._fetch('POST', 'admin/override-wallet', { investorId, newBalance: nb, notes: notesEl.value.trim() || null });
      if (res.success) {
        if (inv) inv.wallet_balance = nb;
        if (resultEl) resultEl.innerHTML = `<span style="color:#4ade80"><i class="fa-solid fa-check"></i> Balance set to ${Utils.rand(nb)} (was ${Utils.rand(oldBal)})</span>`;
        Toast.success(`Wallet balance set to ${Utils.rand(nb)}`);
      } else {
        if (resultEl) resultEl.innerHTML = `<span style="color:#f87171">${res.error || 'Failed'}</span>`;
        Toast.error(res.error || 'Override failed');
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = `<span style="color:#f87171">${e.message}</span>`;
      Toast.error('Override failed: ' + (e.message || 'unknown error'));
    }
  });
}

async function adminInvestOnBehalf(investorId, name, btn) {
  const poolEl   = document.getElementById('adminInvestPool-' + investorId);
  const amtEl    = document.getElementById('adminInvestAmt-' + investorId);
  const feeEl    = document.getElementById('adminInvestFee-' + investorId);
  const resultEl = document.getElementById('adminInvestResult-' + investorId);

  const poolId   = poolEl?.value;
  const amt      = parseFloat(amtEl?.value);
  const chargeFee = feeEl?.checked ?? false;

  if (!poolId) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#f87171">Please select a pool.</span>';
    return;
  }
  if (isNaN(amt) || amt <= 0) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#f87171">Enter a valid investment amount.</span>';
    return;
  }

  const pool      = (STATE.pools || []).find(p => p.id === poolId);
  const fee       = chargeFee ? Math.round(amt * 0.01 * 100) / 100 : 0;
  const total     = amt + fee;
  const feeNote   = chargeFee ? ` + R${fee.toFixed(2)} platform fee` : ' (no platform fee)';
  const inv       = STATE.investors.find(i => i.id === investorId);
  const balance   = parseFloat(inv?.wallet_balance) || 0;

  const confirmed = await Confirm.ask('Create investment on behalf?', {
    body: `Investor: ${name}\nPool: ${pool?.name || poolId}\nAmount: R${amt.toFixed(2)}${feeNote}\nTotal deducted from wallet: R${total.toFixed(2)}\nCurrent wallet: R${balance.toFixed(2)}\n\nThis will create an active investment record and deduct from the investor's wallet.`,
    confirmLabel: 'Create Investment',
  });
  if (!confirmed) return;

  await _withBtn(btn, async () => {
    try {
      const res = await API._fetch('POST', 'admin/invest-on-behalf', { investorId, poolId, amount: amt, chargeFee });
      if (res.success) {
        if (inv) inv.wallet_balance = parseFloat(inv.wallet_balance || 0) - res.totalDeducted;
        if (resultEl) resultEl.innerHTML = `<span style="color:#4ade80"><i class="fa-solid fa-check"></i> Investment created — R${res.amount.toFixed(2)} in ${res.poolName}${res.fee > 0 ? `, R${res.fee.toFixed(2)} fee charged` : ''}</span>`;
        Toast.success(`Investment of R${res.amount.toFixed(2)} created in ${res.poolName}`);
        await viewInvestor(investorId);
        _invTab('investments');
      } else {
        if (resultEl) resultEl.innerHTML = `<span style="color:#f87171">${res.error || 'Failed'}</span>`;
        Toast.error(res.error || 'Investment failed');
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = `<span style="color:#f87171">${e.message}</span>`;
      Toast.error('Investment failed: ' + (e.message || 'unknown error'));
    }
  });
}

async function approveInvestorFica(investorId, btn) {
  if (!await Confirm.ask('Approve FICA?', { body: 'All three required documents (ID, Proof of Address, Proof of Bank) must be individually approved before FICA can be granted. The investor will be marked as verified and their account activated.', confirmLabel: 'Approve FICA' })) return;
  await _withBtn(btn, async () => {
    try {
      await API.investors.update(investorId, { fica_status: 'approved', kyc_status: 'approved', status: 'active' });
      Toast.success('FICA approved — investor is now active');
      Modal.close('investorDetailModal');
      await loadInvestors();
    } catch (e) {
      Toast.error('Failed to approve FICA: ' + (e.message || 'unknown error'));
      console.error('[approveInvestorFica]', e);
    }
  });
}

async function sendLoginInvite(investorId, email, btn) {
  if (!await Confirm.ask('Send login invite?', {
    body: `This will create a login account for ${email || investorId} (if one doesn't exist) and email them a secure link to set their password. The link is valid for 7 days.`,
    confirmLabel: 'Send Invite',
  })) return;
  await _withBtn(btn, async () => {
    try {
      const res = await API._fetch('POST', 'auth/invite-investor', { investor_id: investorId });
      Toast.success(res.message || 'Invite sent');
      // Refresh the badge in place
      const badgeEl = document.getElementById('invInviteBtn');
      if (badgeEl) {
        badgeEl.outerHTML = `<span class="badge badge--green" style="padding:6px 10px"><i class="fa-solid fa-circle-check"></i> Invite sent</span>`;
      }
    } catch (e) {
      Toast.error('Failed to send invite: ' + (e.message || 'unknown error'));
    }
  });
}

async function saveInvestorNotes(investorId) {
  const ta = document.getElementById('invNewNoteTA');
  if (!ta) return;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, { notes: ta.value.trim() });
    const inv = STATE.investors.find(i => i.id === investorId);
    if (inv) inv.notes = ta.value.trim();
    Toast.success('Notes saved');
  } catch (e) { Toast.error('Failed to save notes'); }
}

/** Find an investor's outstanding (pending/under_review) proof-of-bank documents. */
async function _pendingProofOfBankDocs(investorId) {
  try {
    const res = await API.kyc.list({ investor_id: investorId, limit: 200 });
    return (res.data || []).filter(d => d.doc_type === 'proof_of_bank' && ['pending', 'under_review'].includes(d.status));
  } catch (_) { return []; }
}

function editBankDetails(investorId) {
  const inv = STATE.investors.find(i => i.id === investorId);
  if (!inv) return;
  document.getElementById('ebf-investor-id').value     = investorId;
  document.getElementById('editBankSubtitle').textContent = `${inv.first_name} ${inv.last_name}`;
  document.getElementById('ebf-bank-name').value        = inv.bank_name           || '';
  document.getElementById('ebf-account-holder').value   = inv.bank_account_holder || '';
  document.getElementById('ebf-account-number').value   = inv.bank_account_number || '';
  document.getElementById('ebf-branch-code').value      = inv.bank_branch_code    || '';
  document.getElementById('ebf-account-type').value     = inv.bank_account_type   || 'current';
  document.getElementById('ebf-account-status').value   = inv.bank_account_status || 'none';
  document.getElementById('ebf-notes').value            = inv.bank_account_notes  || '';
  Modal.open('editBankModal');
}

async function _saveBankDetails(btn) {
  const investorId = document.getElementById('ebf-investor-id').value;
  if (!investorId) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
  try {
    const payload = {
      bank_name:            document.getElementById('ebf-bank-name').value.trim()       || null,
      bank_account_holder:  document.getElementById('ebf-account-holder').value.trim()  || null,
      bank_account_number:  document.getElementById('ebf-account-number').value.trim()  || null,
      bank_branch_code:     document.getElementById('ebf-branch-code').value.trim()     || null,
      bank_account_type:    document.getElementById('ebf-account-type').value           || 'current',
      bank_account_status:  document.getElementById('ebf-account-status').value         || 'none',
      bank_account_notes:   document.getElementById('ebf-notes').value.trim()           || null,
    };
    await API._fetch('PATCH', `tables/investors/${investorId}`, payload);
    const inv = STATE.investors.find(i => i.id === investorId);
    if (inv) Object.assign(inv, payload);
    Toast.success('Banking details saved.');
    Modal.close('editBankModal');
    await viewInvestor(investorId);
    _invTab('overview');
  } catch (e) {
    Toast.error('Failed to save: ' + (e.message || 'unknown error'));
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function editSaBankDetails(saId) {
  const sa = (STATE.subAccounts || []).find(s => s.id === saId);
  if (!sa) return;
  document.getElementById('esabf-sa-id').value          = saId;
  document.getElementById('editSaBankSubtitle').textContent = sa.name || sa.sa_reference || saId;
  document.getElementById('esabf-bank-name').value       = sa.sa_bank_name   || '';
  document.getElementById('esabf-account-holder').value  = sa.sa_bank_holder || '';
  document.getElementById('esabf-account-number').value  = sa.sa_bank_number || '';
  document.getElementById('esabf-branch-code').value     = sa.sa_bank_branch || '';
  document.getElementById('esabf-account-type').value    = sa.sa_bank_type   || 'current';
  document.getElementById('esabf-account-status').value  = sa.sa_bank_status || 'none';
  Modal.open('editSaBankModal');
}

async function _saveSaBankDetails(btn) {
  const saId = document.getElementById('esabf-sa-id').value;
  if (!saId) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
  try {
    const payload = {
      sa_bank_name:   document.getElementById('esabf-bank-name').value.trim()       || null,
      sa_bank_holder: document.getElementById('esabf-account-holder').value.trim()  || null,
      sa_bank_number: document.getElementById('esabf-account-number').value.trim()  || null,
      sa_bank_branch: document.getElementById('esabf-branch-code').value.trim()     || null,
      sa_bank_type:   document.getElementById('esabf-account-type').value           || 'current',
      sa_bank_status: document.getElementById('esabf-account-status').value         || 'none',
    };
    await API._fetch('PATCH', `tables/sub_accounts/${saId}`, payload);
    const sa = (STATE.subAccounts || []).find(s => s.id === saId);
    if (sa) Object.assign(sa, payload);
    Toast.success('Banking details saved.');
    Modal.close('editSaBankModal');
    viewSubAccount(saId);
  } catch (e) {
    Toast.error('Failed to save: ' + (e.message || 'unknown error'));
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function approveBankAccount(investorId, btn) {
  if (!await Confirm.ask('Approve bank account?', { body: 'This will enable withdrawals for this investor and send a confirmation.', confirmLabel: 'Approve' })) return;
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/investors/${investorId}`, { bank_account_status: 'approved', bank_account_notes: null });
      // Approving the bank account also approves the attached proof-of-bank document.
      const reviewedBy = _getAdminName();
      const proofs = await _pendingProofOfBankDocs(investorId);
      for (const d of proofs) {
        await API.kyc.update(d.id, { status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() });
      }
      // Recompute overall FICA — proof of bank is one of the three required documents.
      await _recomputeInvestorFicaStatus(investorId);
      Toast.success('Bank account approved — investor can now request withdrawals');
      Modal.close('investorDetailModal');
      await loadInvestors();
    } catch (e) {
      Toast.error('Failed to approve bank account: ' + (e.message || 'unknown error'));
      console.error('[approveBankAccount]', e);
    }
  });
}

async function rejectBankAccount(investorId) {
  const reason = prompt('Reason for rejection (will be visible to investor):');
  if (reason === null) return;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, {
      bank_account_status: 'rejected',
      bank_account_notes:  reason || 'Bank account details could not be verified.',
    });
    // Rejecting the bank account also rejects the attached proof-of-bank document.
    const reviewedBy = _getAdminName();
    const proofs = await _pendingProofOfBankDocs(investorId);
    for (const d of proofs) {
      await API.kyc.update(d.id, { status: 'rejected', notes: reason || 'Bank account details could not be verified.', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() });
    }
    await _recomputeInvestorFicaStatus(investorId);
    Toast.success('Bank account rejected');
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to reject bank account'); }
}

/* ═══════════════════════════════════════════════
   WITHDRAWALS — Feature 5: Approval Workflow
   ═══════════════════════════════════════════════ */
async function loadWithdrawals() {
  try {
    const [txnRes, invRes] = await Promise.all([
      API._fetch('GET', 'tables/transactions', null, { type: 'withdrawal', limit: 300 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 })
    ]);
    const all = (txnRes.data || []).filter(t => t.type === 'withdrawal');
    STATE.withdrawals = all;
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderWithdrawalsTable();
  } catch (e) {
    Toast.error('Failed to load withdrawals');
    console.error(e);
  }
}

function renderWithdrawalsTable() {
  const pendingBody   = document.getElementById('withdrawalsPendingBody');
  const completedBody = document.getElementById('withdrawalsCompletedBody');
  const withdrawals   = STATE.withdrawals || [];

  // ── Read filter values ──────────────────────────────────────────────────
  const fName = (document.getElementById('wdFilterName')?.value || '').toLowerCase().trim();
  const fRef  = (document.getElementById('wdFilterRef')?.value  || '').toLowerCase().trim();
  const fMin  = parseFloat(document.getElementById('wdFilterMin')?.value) || 0;
  const fMax  = parseFloat(document.getElementById('wdFilterMax')?.value) || Infinity;
  const fFrom = document.getElementById('wdFilterFrom')?.value || '';
  const fTo   = document.getElementById('wdFilterTo')?.value   || '';

  const _matchesFilter = (w) => {
    const inv  = STATE.investors.find(i => i.id === w.investor_id);
    const name = inv ? `${inv.first_name} ${inv.last_name}`.toLowerCase() : '';
    const id   = (w.investor_id || '').toLowerCase();
    if (fName && !name.includes(fName) && !id.includes(fName)) return false;
    if (fRef  && !(w.reference || '').toLowerCase().includes(fRef))  return false;
    const amt = Math.abs(parseFloat(w.amount) || 0);
    if (fMin  && amt < fMin) return false;
    if (fMax !== Infinity && amt > fMax) return false;
    const d = (w.created_at || w.transaction_date || '').slice(0, 10);
    if (fFrom && d < fFrom) return false;
    if (fTo   && d > fTo)   return false;
    return true;
  };

  const allPending   = withdrawals.filter(w => w.status === 'pending');
  const pending      = allPending.filter(_matchesFilter);
  const completed    = withdrawals.filter(w => w.status !== 'pending');

  // Update filter count label
  const countEl = document.getElementById('wdFilterCount');
  if (countEl) {
    const hasFilter = fName || fRef || fMin || fMax !== Infinity || fFrom || fTo;
    countEl.textContent = hasFilter ? `${pending.length} of ${allPending.length} shown` : `${allPending.length} pending`;
  }

  const _row = (w, showActions) => {
    const inv  = STATE.investors.find(i => i.id === w.investor_id);
    const name = inv ? `${inv.first_name} ${inv.last_name}` : w.investor_id || '—';
    const saBadge = w.sub_account_id
      ? (() => { const sa = (STATE.subAccounts || []).find(s => s.id === w.sub_account_id); return `<div style="margin-top:2px"><span style="background:rgba(237,165,255,.15);color:#eda5ff;border-radius:4px;padding:1px 6px;font-size:0.65rem;font-weight:700">SA: ${sa ? _esc(sa.name) : 'Sub-Account'}</span></div>`; })()
      : '';

    let bankNotes = {};
    try { if (inv?.notes?.startsWith('{')) bankNotes = JSON.parse(inv.notes); } catch(_) {}
    const bankName   = inv?.bank_name           || bankNotes.bank_name    || '—';
    const bankAcct   = inv?.bank_account_number || bankNotes.account_number || '';
    const bankHolder = inv?.bank_account_holder || bankNotes.account_holder || (inv ? `${inv.first_name} ${inv.last_name}` : '—');
    const branchCode = inv?.bank_branch_code    || bankNotes.branch_code  || '—';
    const bankDisplay = bankAcct
      ? `<div style="font-size:0.78rem;font-weight:600;color:var(--text)">${bankName}</div>
         <div style="font-size:0.7rem;color:var(--text-muted)">${bankHolder}</div>
         <div style="font-size:0.68rem;font-family:monospace;color:var(--gold)">${String(bankAcct)} · ${branchCode}</div>`
      : `<div class="clip">${bankName}</div>`;

    const checkCol = showActions
      ? `<td style="padding-left:14px;width:36px"><input type="checkbox" class="wd-check" data-id='${w.id}' onchange="_updateWithdrawalSelection()"></td>`
      : `<td></td>`;

    const dateCreated = w.transaction_date || w.created_at;
    const dateUpdated = w.date_updated || w.updated_at;
    return `<tr>
      ${checkCol}
      <td class="td-muted clip" style="font-size:0.78rem">
        <div>${Utils.date(dateCreated)}</div>
        ${dateUpdated ? `<div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">Upd: ${Utils.date(dateUpdated)}</div>` : ''}
      </td>
      <td><div class="td-strong clip">${name}</div><div class="td-muted clip" style="font-size:0.7rem">${w.investor_id||''}</div>${saBadge}</td>
      <td class="td-gold fw-700 clip">${Utils.rand(Math.abs(w.amount))}</td>
      <td>${bankDisplay}</td>
      <td class="td-muted clip" style="font-size:0.75rem">${w.reference || '—'}</td>
      <td>
        ${showActions ? `
          <div class="flex-center gap-6">
            <button class="btn btn--success btn--sm" onclick='approveWithdrawal(${JSON.stringify(w.id)}, this)'><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn--danger btn--sm" onclick='rejectWithdrawalPrompt(${JSON.stringify(w.id)}, this)'><i class="fa-solid fa-xmark"></i> Reject</button>
          </div>
        ` : Utils.statusBadge(w.status)}
      </td>
    </tr>`;
  };

  if (pendingBody) {
    pendingBody.innerHTML = pending.length
      ? pending.map(w => _row(w, true)).join('')
      : `<tr><td colspan="7" class="text-center text-muted" style="padding:24px"><i class="fa-solid fa-check-circle" style="color:var(--green);margin-right:6px"></i>${allPending.length ? 'No withdrawals match the current filter' : 'No pending withdrawals'}</td></tr>`;
    _updateWithdrawalSelection();
  }

  if (completedBody) {
    completedBody.innerHTML = completed.length
      ? completed.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(w => _row(w, false)).join('')
      : '<tr><td colspan="7" class="text-center text-muted" style="padding:24px">No completed withdrawals</td></tr>';
  }
}

function clearWithdrawalFilters() {
  ['wdFilterName','wdFilterRef','wdFilterMin','wdFilterMax','wdFilterFrom','wdFilterTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderWithdrawalsTable();
}

function _updateWithdrawalSelection() {
  const checks   = [...document.querySelectorAll('.wd-check')];
  const selected = checks.filter(c => c.checked);
  const bulkBar  = document.getElementById('wdBulkBar');
  const selCount = document.getElementById('wdSelCount');
  const selAll   = document.getElementById('wdSelectAll');

  if (bulkBar) bulkBar.style.display = selected.length ? 'flex' : 'none';
  if (selCount) selCount.textContent = `${selected.length} selected`;
  if (selAll) {
    selAll.indeterminate = selected.length > 0 && selected.length < checks.length;
    selAll.checked = checks.length > 0 && selected.length === checks.length;
  }
}

function _toggleSelectAllWithdrawals(masterCb) {
  document.querySelectorAll('.wd-check').forEach(c => { c.checked = masterCb.checked; });
  _updateWithdrawalSelection();
}

function _clearWithdrawalSelection() {
  document.querySelectorAll('.wd-check').forEach(c => { c.checked = false; });
  _updateWithdrawalSelection();
}

async function _bulkApplyWithdrawalStatus() {
  const status = document.getElementById('wdBulkStatus')?.value;
  if (!status) { Toast.error('Choose a status to apply'); return; }

  const ids = [...document.querySelectorAll('.wd-check:checked')].map(c => c.dataset.id).filter(Boolean);
  if (!ids.length) { Toast.error('No withdrawals selected'); return; }

  const labelMap = { completed: 'completed', rejected: 'rejected', pending: 'reset to pending' };
  if (!await Confirm.ask(`Apply to ${ids.length} withdrawal${ids.length > 1 ? 's' : ''}?`, {
    body: `This will mark ${ids.length} withdrawal${ids.length > 1 ? 's' : ''} as ${labelMap[status] || status}.`,
    confirmLabel: 'Apply',
    danger: status === 'rejected',
  })) return;

  let done = 0, failed = 0;
  await Promise.all(ids.map(async (id) => {
    try {
      await API._fetch('PATCH', `tables/transactions/${id}`, { status });
      done++;
    } catch {
      failed++;
    }
  }));

  if (failed) Toast.error(`${done} updated, ${failed} failed`);
  else Toast.success(`${done} withdrawal${done > 1 ? 's' : ''} marked as ${status}`);

  await loadWithdrawals();
}

async function approveWithdrawal(txnId, btn) {
  if (!txnId) { Toast.error('Invalid withdrawal ID'); return; }
  if (!await Confirm.ask('Approve this withdrawal?', { body: 'The investor\'s funds will be marked as released to their bank account.', confirmLabel: 'Approve' })) return;
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/transactions/${txnId}`, { status: 'completed' });
      // Deduct from investor wallet if still showing balance
      const txn = STATE.withdrawals.find(w => w.id === txnId);
      if (txn && txn.investor_id) {
        const inv = STATE.investors.find(i => i.id === txn.investor_id);
        if (inv && inv.wallet_balance > 0) {
          const deduct = Math.abs(parseFloat(txn.amount) || 0);
          const newBal = Math.max(0, Math.round(((inv.wallet_balance || 0) - deduct) * 100) / 100);
          await API._fetch('PATCH', `tables/investors/${txn.investor_id}`, { wallet_balance: newBal });
        }
      }
      Toast.success('Withdrawal approved — funds released to investor bank account');
      await loadWithdrawals();
    } catch (e) {
      Toast.error('Failed to approve withdrawal: ' + (e.message || 'unknown error'));
      console.error('[approveWithdrawal]', e);
    }
  });
}

/* Shared in-page rejection modal — used for both withdrawals and KYC docs */
let _rejectingTxnId = null;
let _rejectingKycId = null;
let _rejectBtn = null;
let _rejectMode = 'withdrawal'; // 'withdrawal' | 'kyc'

function _setRejectTemplate(text) {
  const el = document.getElementById('rejectReasonInput');
  if (el) { el.value = text; el.focus(); }
}

function rejectWithdrawalPrompt(txnId, btn) {
  if (!txnId) { Toast.error('Invalid withdrawal ID'); return; }
  _rejectingTxnId = txnId;
  _rejectingKycId = null;
  _rejectMode = 'withdrawal';
  _rejectBtn = btn;
  document.getElementById('rejectModalTitle').textContent = 'Reject Withdrawal';
  document.getElementById('rejectModalBody').textContent = 'The investor will be notified and the funds returned to their wallet. Provide a reason below (optional).';
  document.getElementById('rejectReasonInput').value = '';
  const tpl = document.getElementById('kycRejectTemplates');
  if (tpl) tpl.style.display = 'none';
  const emailRow = document.getElementById('kycRejectEmailRow');
  if (emailRow) emailRow.style.display = 'none';
  const overlay = document.getElementById('rejectModal');
  overlay.style.display = 'flex';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('rejectReasonInput')?.focus(), 100);
}

async function _submitRejection() {
  const reason = (document.getElementById('rejectReasonInput')?.value || '').trim();
  const txnId  = _rejectingTxnId;
  const kycId  = _rejectingKycId;
  const btn    = _rejectBtn;
  const mode   = _rejectMode;
  const rm = document.getElementById('rejectModal');
  rm.style.display = 'none';
  rm.classList.remove('open');
  document.body.style.overflow = '';

  if (mode === 'kyc' && kycId === '__bulk__') {
    const shouldEmail = document.getElementById('kycRejectEmailInvestor')?.checked !== false;
    await _executeBulkKycReject(reason, shouldEmail);
    return;
  }

  if (mode === 'kyc' && kycId) {
    const shouldEmail = document.getElementById('kycRejectEmailInvestor')?.checked !== false;
    await _withBtn(btn, async () => {
      try {
        const reviewedBy = _getAdminName();
        await API.kyc.update(kycId, {
          status: 'rejected',
          notes: reason || 'Document rejected by admin.',
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
        });
        const doc = STATE.kyc.find(k => k.id === kycId);
        if (doc?.investor_id && doc?.doc_type === 'proof_of_bank') {
          await API._fetch('PATCH', `tables/investors/${doc.investor_id}`, {
            bank_account_status: 'rejected',
            bank_account_notes: reason || 'Bank account details could not be verified.',
          }).catch(e => console.warn('[rejectKyc] bank status update failed:', e.message));
        }
        await _recomputeInvestorFicaStatus(doc?.investor_id).catch(() => {});

        // Auto-email investor with rejection reason
        if (shouldEmail && doc?.investor_id) {
          const inv = STATE.investors.find(i => i.id === doc.investor_id);
          if (inv?.email) {
            const DOC_LABELS = { id_document: 'Identity Document', proof_of_address: 'Proof of Address', proof_of_bank: 'Proof of Bank Account' };
            const docLabel = DOC_LABELS[doc.doc_type] || 'KYC document';
            const firstName = inv.first_name || 'Investor';
            const rejectionReason = reason || 'Please re-upload a clearer, current document that meets our requirements.';
            await API._fetch('POST', 'admin/send-investor-email', {
              investor_id: inv.id,
              subject: `Action required: Your ${docLabel} — SV Capital`,
              message: `Dear ${firstName},\n\nThank you for submitting your documents. Unfortunately, we were unable to accept your ${docLabel} at this time.\n\nReason: ${rejectionReason}\n\nTo resubmit, please log in to your SV Capital investor portal, navigate to your profile or KYC section, and upload a new copy of the document.\n\nIf you have any questions or need assistance, please contact us at support@svcapital.co.za.\n\nKind regards,\nSV Capital Compliance Team`,
            }).catch(e => console.warn('[kycReject] email notification failed:', e.message));
          }
        }

        Toast.success('Document rejected' + (shouldEmail ? ' — investor notified by email' : ''));
        await loadKYC();
      } catch (e) {
        Toast.error('Failed to reject document: ' + (e.message || 'unknown error'));
        console.error('[rejectKyc]', e);
        await loadKYC().catch(() => {});
      }
    });
    return;
  }

  if (!txnId) return;
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/transactions/${txnId}`, {
        status: 'rejected',
        description: reason || 'Withdrawal rejected by admin.',
      });
      Toast.success('Withdrawal rejected — funds remain in investor wallet');
      await loadWithdrawals();
    } catch (e) {
      Toast.error('Failed to reject withdrawal: ' + (e.message || 'unknown error'));
      console.error('[rejectWithdrawal]', e);
    }
  });
}

// Keep legacy aliases
async function processWithdrawal(txnId) { return approveWithdrawal(txnId); }
async function rejectWithdrawal(txnId) { return rejectWithdrawalPrompt(txnId); }

async function confirmArchiveInvestor(id, btn) {
  if (!await Confirm.ask('Archive investor?', { body: 'They can still log in but will be excluded from stats and broadcasts. They will be automatically restored when they make an investment.', confirmLabel: 'Archive' })) return;
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/investors/${id}`, { status: 'archived', archived_at: new Date().toISOString() });
      Toast.success('Investor archived');
      Modal.closeAll();
      await loadInvestors();
    } catch (e) {
      Toast.error('Failed to archive investor: ' + (e.message || 'unknown error'));
    }
  });
}

async function unarchiveInvestor(id, btn) {
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/investors/${id}`, { status: 'active', archived_at: null });
      Toast.success('Investor restored');
      Modal.closeAll();
      await loadInvestors();
    } catch (e) {
      Toast.error('Failed to unarchive investor: ' + (e.message || 'unknown error'));
    }
  });
}

async function openMoveInvestment(investmentId, currentPoolId) {
  // Build pool options from STATE, excluding current pool
  const pools = (STATE.pools || []).filter(p => p.id !== currentPoolId && ['open','filling','active'].includes(p.status));
  if (!pools.length) {
    // Fetch fresh if STATE empty
    try {
      const res = await API.pools.list({ limit: 1000 });
      STATE.pools = res.data || [];
    } catch (e) { /* ignore */ }
  }
  const eligible = (STATE.pools || []).filter(p => p.id !== currentPoolId && ['open','filling','active'].includes(p.status));

  const opts = eligible.map(p =>
    `<option value="${_esc(String(p.id))}">${_esc(p.name||p.id)}</option>`
  ).join('');

  const body = `
    <div style="padding:24px;min-width:340px">
      <h3 style="margin:0 0 16px;font-size:1rem">Move Investment to Pool</h3>
      <label style="font-size:0.78rem;color:var(--text-muted);display:block;margin-bottom:6px">Select destination pool</label>
      <select id="movePoolSelect" class="form-control" style="width:100%;margin-bottom:20px">
        <option value="">— choose a pool —</option>
        ${opts}
      </select>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" onclick="Modal.closeAll()">Cancel</button>
        <button class="btn btn--primary" id="movePoolConfirmBtn" onclick='_confirmMoveInvestment(${JSON.stringify(investmentId)})'>Move</button>
      </div>
    </div>`;

  Modal.openInline(body);
}

async function _confirmMoveInvestment(investmentId) {
  const sel = document.getElementById('movePoolSelect');
  if (!sel || !sel.value) { Toast.error('Please select a destination pool'); return; }
  const newPoolId = sel.value;
  const newPool = (STATE.pools || []).find(p => String(p.id) === String(newPoolId));
  const btn = document.getElementById('movePoolConfirmBtn');
  await _withBtn(btn, async () => {
    try {
      await API._fetch('PATCH', `tables/investments/${investmentId}`, {
        pool_id: newPoolId,
        pool_name: newPool ? newPool.name : undefined,
      });
      Toast.success('Investment moved successfully');
      Modal.closeAll();
      // If we were in a pool investors view, refresh it so stats update
      if (_currentPoolId) {
        await viewPoolInvestors(_currentPoolId);
      } else if (_currentInvestorId) {
        await viewInvestor(_currentInvestorId);
      }
    } catch (e) {
      Toast.error('Failed to move investment: ' + (e.message || 'unknown error'));
    }
  });
}

async function openAddInvestorModal() {
  Modal.open('addInvestorModal');
  // Inline validation on key fields
  _setupFieldValidation('newInvEmail', v => {
    if (!v) return '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? true : false;
  });
  _setupFieldValidation('newInvPhone', v => {
    if (!v) return '';
    const clean = v.replace(/\s/g,'');
    return /^(\+27|0)[6-8][0-9]{8}$/.test(clean) ? true : false;
  });
  const el = document.getElementById('newInvAccountNo');
  if (el) el.textContent = 'Generating…';
  try {
    const r = await fetch('/api/tables/investors/next-account', {
      headers: { Authorization: `Bearer ${localStorage.getItem('svc_token')}` }
    });
    if (r.ok) {
      const d = await r.json();
      if (el) el.textContent = d.account_number;
      window._pendingInvestorAccountNo = d.account_number;
    } else {
      if (el) el.textContent = '—';
    }
  } catch (_) {
    if (el) el.textContent = '—';
  }
}

async function saveNewInvestor(btn) {
  const fn = document.getElementById('newInvFirstName').value.trim();
  const ln = document.getElementById('newInvLastName').value.trim();
  const em = document.getElementById('newInvEmail').value.trim();
  if (!fn || !ln || !em) { Toast.error('First name, last name and email are required'); return; }

  // SA ID number validation
  const idNum = (document.getElementById('newInvIdNum').value || '').trim();
  if (idNum) {
    if (!/^\d{13}$/.test(idNum)) {
      Toast.error('SA ID number must be exactly 13 digits'); return;
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      let d = parseInt(idNum[i]);
      if (i % 2 !== 0) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if ((10 - (sum % 10)) % 10 !== parseInt(idNum[12])) {
      Toast.error('SA ID number checksum is invalid — please verify the number'); return;
    }
    const yy = parseInt(idNum.substring(0, 2)), mm = parseInt(idNum.substring(2, 4)), dd = parseInt(idNum.substring(4, 6));
    const year = yy + (yy > new Date().getFullYear() % 100 ? 1900 : 2000);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) { Toast.error('SA ID contains an invalid date of birth'); return; }
    const age = Math.floor((Date.now() - new Date(year, mm - 1, dd)) / (365.25 * 24 * 3600 * 1000));
    if (age < 18) { Toast.error('Investor must be at least 18 years old'); return; }
  }

  const accountNo = window._pendingInvestorAccountNo || `INV-${Date.now()}`;

  await _withBtn(btn, async () => {
    try {
      await API.investors.create({
        id: accountNo,
        first_name: fn, last_name: ln, email: em,
        phone: document.getElementById('newInvPhone').value.trim(),
        id_number: document.getElementById('newInvIdNum').value.trim(),
        risk_profile: document.getElementById('newInvRisk').value,
        address: document.getElementById('newInvCity').value.trim(),
        province: document.getElementById('newInvProvince').value,
        notes: document.getElementById('newInvNotes').value.trim(),
        status: 'pending', fica_status: 'pending',
        wallet_balance: 0, total_invested: 0, total_returns: 0,
        date_joined: new Date().toISOString(),
      });
      window._pendingInvestorAccountNo = null;
      Toast.success(`Investor created — Account: ${accountNo}`);
      Modal.close('addInvestorModal');
      await loadInvestors();
    } catch (e) {
      Toast.error('Failed to create investor: ' + (e.message || 'unknown error'));
      console.error('[saveNewInvestor]', e);
    }
  });
}

/* ═══════════════════════════════════════════════
   KYC / FICA
   ═══════════════════════════════════════════════ */
async function loadKYC() {
  try {
    const [kycRes, invRes] = await Promise.all([
      API.kyc.list({ limit: 5000 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 })
    ]);
    STATE.kyc = (kycRes.data || []).sort((a, b) =>
      new Date(b.submitted_at || b.uploaded_at || b.created_at || 0) - new Date(a.submitted_at || a.uploaded_at || a.created_at || 0)
    );
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderKYCStats();
    renderKYCTable();

    // Filters are wired via inline onchange/oninput in HTML; guard against double-wiring the status filter
    const kycFilterEl = document.getElementById('kycStatusFilter');
    if (kycFilterEl && !kycFilterEl._wired) { kycFilterEl._wired = true; }
  } catch (e) {
    Toast.error('Failed to load KYC data');
    const kycBody = document.getElementById('kycBody');
    if (kycBody) kycBody.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px"><i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;color:#fec24f"></i>Failed to load KYC documents — please refresh the page.</td></tr>';
  }
}

function renderKYCStats() {
  const d = STATE.kyc;
  const pending  = d.filter(k => k.status === 'pending').length;
  const review   = d.filter(k => k.status === 'under_review').length;
  const approved = d.filter(k => k.status === 'approved').length;
  const rejected = d.filter(k => k.status === 'rejected').length;
  document.getElementById('kyc-pending').textContent  = pending;
  document.getElementById('kyc-review').textContent   = review;
  document.getElementById('kyc-approved').textContent = approved;
  document.getElementById('kyc-rejected').textContent = rejected;
  document.getElementById('kycBadge').textContent     = pending + review;

  // Per-doc-type breakdown with avg processing time
  const DOC_LABELS = {
    id_document: 'ID Document', proof_of_address: 'Proof of Address',
    proof_of_bank: 'Proof of Bank', other: 'Other',
  };
  const DOC_ICONS = {
    id_document: 'fa-id-card', proof_of_address: 'fa-house',
    proof_of_bank: 'fa-building-columns', other: 'fa-file',
  };
  const knownTypes = ['id_document', 'proof_of_address', 'proof_of_bank'];
  const typeGroups = {};
  for (const k of d) {
    const t = knownTypes.includes(k.doc_type) ? k.doc_type : 'other';
    if (!typeGroups[t]) typeGroups[t] = [];
    typeGroups[t].push(k);
  }

  function _avgHours(docs) {
    const reviewed = docs.filter(k => {
      const sub = k.submitted_at || k.submitted_date || k.created_at;
      const rev = k.reviewed_at  || k.reviewed_date;
      return sub && rev;
    });
    if (!reviewed.length) return null;
    const ms = reviewed.reduce((s, k) => {
      const sub = new Date(k.submitted_at || k.submitted_date || k.created_at);
      const rev = new Date(k.reviewed_at  || k.reviewed_date);
      return s + Math.max(0, rev - sub);
    }, 0) / reviewed.length;
    const h = ms / 3600000;
    return h < 24 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`;
  }

  const container = document.getElementById('kycDocTypeStats');
  if (!container) return;
  const allTypes = [...new Set(['id_document', 'proof_of_address', 'proof_of_bank', ...Object.keys(typeGroups)])];
  container.innerHTML = allTypes.map(t => {
    const docs    = typeGroups[t] || [];
    const pend    = docs.filter(k => ['pending', 'under_review'].includes(k.status)).length;
    const total   = docs.length;
    const avg     = _avgHours(docs);
    const icon    = DOC_ICONS[t] || 'fa-file';
    const label   = DOC_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const pendClr = pend > 0 ? '#fec24f' : 'var(--text-muted)';
    return `<div class="stat-card" style="cursor:pointer;padding:12px 14px" onclick="document.getElementById('kycDocTypeFilter').value=${JSON.stringify(t)};renderKYCTable()">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <i class="fa-solid ${icon}" style="color:#eda5ff;font-size:0.9rem"></i>
        <span style="font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${label}</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:8px">
        <span style="font-size:1.4rem;font-weight:800;color:var(--text)">${total}</span>
        <span style="font-size:0.75rem;font-weight:600;color:${pendClr};margin-bottom:2px">${pend} pending</span>
      </div>
      ${avg ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px"><i class="fa-solid fa-clock" style="margin-right:3px"></i>Avg review: <strong>${avg}</strong></div>` : `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px">No reviewed docs yet</div>`}
    </div>`;
  }).join('');

  // FICA compliance breakdown — 0/3, 1/3, 2/3, 3/3 approved docs per investor
  const fcEl = document.getElementById('ficaComplianceBreakdown');
  if (fcEl && STATE.investors.length) {
    const REQ_DOCS = ['id_document', 'proof_of_address', 'proof_of_bank'];
    const approvedByInv = {};
    for (const doc of d) {
      if (doc.status !== 'approved') continue;
      if (!REQ_DOCS.includes(doc.doc_type)) continue;
      if (!approvedByInv[doc.investor_id]) approvedByInv[doc.investor_id] = new Set();
      approvedByInv[doc.investor_id].add(doc.doc_type);
    }
    const buckets = [0, 0, 0, 0]; // index = approved doc count (0–3)
    let invCount = 0;
    for (const inv of STATE.investors) {
      if (inv.role && inv.role !== 'investor') continue;
      invCount++;
      const n = (approvedByInv[inv.id] || new Set()).size;
      buckets[Math.min(3, n)]++;
    }
    const BUCKET_COLORS = ['#7a92a8', '#fec24f', '#60a5fa', '#22c55e'];
    const BUCKET_LABELS = ['0 of 3 docs', '1 of 3 docs', '2 of 3 docs', 'Fully verified'];
    const BUCKET_ICONS  = ['fa-circle-xmark', 'fa-circle-half-stroke', 'fa-circle-three-quarters-stroke', 'fa-circle-check'];
    fcEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">FICA Compliance Breakdown</span>
        <span style="font-size:0.72rem;color:var(--text-muted)">(${invCount} investors)</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        ${buckets.map((n, i) => {
          const pct = invCount ? Math.round(n / invCount * 100) : 0;
          return `<div style="padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid ${BUCKET_COLORS[i]}22">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
              <i class="fa-solid ${BUCKET_ICONS[i]}" style="color:${BUCKET_COLORS[i]};font-size:0.78rem"></i>
              <span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${BUCKET_COLORS[i]}">${BUCKET_LABELS[i]}</span>
            </div>
            <div style="font-size:1.3rem;font-weight:800;color:${BUCKET_COLORS[i]}">${n}</div>
            <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:6px"><div style="height:100%;width:${pct}%;background:${BUCKET_COLORS[i]};border-radius:2px"></div></div>
            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:3px">${pct}% of investors</div>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function renderKYCTable() {
  const body       = document.getElementById('kycBody');
  const stFilter   = (document.getElementById('kycStatusFilter')?.value  || '').trim();
  const dtFilter   = (document.getElementById('kycDocTypeFilter')?.value || '').trim();
  const search     = (document.getElementById('kycSearch')?.value        || '').trim().toLowerCase();
  const knownTypes = ['id_document', 'proof_of_address', 'proof_of_bank'];

  const items = STATE.kyc.filter(k => {
    if (stFilter && k.status !== stFilter) return false;
    if (dtFilter) {
      const kt = knownTypes.includes(k.doc_type) ? k.doc_type : 'other';
      if (kt !== dtFilter) return false;
    }
    if (search) {
      const inv  = STATE.investors.find(i => i.id === k.investor_id);
      const name = (k.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : '') || '').toLowerCase();
      const id   = (k.investor_id || '').toLowerCase();
      if (!name.includes(search) && !id.includes(search)) return false;
    }
    return true;
  });

  if (!items.length) {
    body.innerHTML = stFilter === 'pending'
      ? _emptyRow('fa-circle-check', 'All clear — no pending KYC', 'All submitted documents have been reviewed.', 8)
      : _emptyRow('fa-id-card', 'No KYC documents found', 'Documents will appear here once investors submit them.', 8);
    return;
  }

  const allCb2 = document.getElementById('kycSelectAll');
  if (allCb2) allCb2.checked = false;

  body.innerHTML = items.map(k => {
    const kInv = STATE.investors.find(i => i.id === k.investor_id);
    const kName = k.investor_name || (kInv ? `${kInv.first_name} ${kInv.last_name}`.trim() : k.investor_id || '—');
    const canSelect = ['pending', 'under_review'].includes(k.status);
    const isBankDoc = k.doc_type === 'proof_of_bank';

    // Expiry warning
    const kExpDate = k.expiry_date ? new Date(k.expiry_date) : null;
    const kDaysToExp = kExpDate ? Math.round((kExpDate - new Date()) / 86400000) : null;
    const kRowExpiryStyle = kDaysToExp !== null && kDaysToExp < 30 && k.status !== 'rejected'
      ? ';background:rgba(254,194,79,0.03);border-left:2px solid rgba(254,194,79,0.35)'
      : kDaysToExp !== null && kDaysToExp < 0 && k.status !== 'rejected'
        ? ';background:rgba(239,68,68,0.03);border-left:2px solid rgba(239,68,68,0.35)'
        : '';

    // Detect if this KYC doc was submitted for a sub-account
    const _saNotesMatch = (k.notes || '').match(/^Sub-account banking:\s*(.+?)\s*—/i);
    const _isSubAcctDoc = !!_saNotesMatch;
    const _saDocName    = _saNotesMatch ? _saNotesMatch[1].trim() : '';

    // Sub-account badge shown in both bank and non-bank doc rows
    const _subAcctBadge = _isSubAcctDoc
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.65rem;font-weight:700;color:#eda5ff;background:rgba(237,165,255,0.12);border:1px solid rgba(237,165,255,0.3);border-radius:6px;padding:2px 7px;margin-bottom:4px"><i class="fa-solid fa-layer-group" style="font-size:0.6rem"></i>Sub Account${_saDocName ? ': ' + _esc(_saDocName) : ''}</span><br>`
      : '';

    // For proof_of_bank rows, surface the bank details the investor submitted
    const _subtypeLabels = { rsa_id: 'SA ID', passport: 'Passport', asylum_permit: 'Asylum Permit' };
    const _subtypeBadge = k.doc_subtype
      ? `<span style="display:inline-block;margin-top:2px;font-size:0.63rem;font-weight:700;color:#9ca3af;background:rgba(0,0,0,0.07);border-radius:4px;padding:1px 5px">${_subtypeLabels[k.doc_subtype] || k.doc_subtype}</span><br>`
      : '';
    let docTypeCell = `${_subAcctBadge}${k.doc_type?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—'}<br>${_subtypeBadge}`;
    if (isBankDoc && kInv) {
      const bankName    = _esc(kInv.bank_name || '—');
      const bankHolder  = _esc(kInv.bank_account_holder || '—');
      const rawAcct     = kInv.bank_account_number || '';
      const masked      = rawAcct ? '••••' + String(rawAcct).slice(-4) : '—';
      const acctType    = _esc(kInv.bank_account_type || '—');
      const branchCode  = _esc(kInv.bank_branch_code  || '—');
      const bkStatus    = kInv.bank_account_status || 'pending';
      const bkCls       = { approved: 'badge--green', rejected: 'badge--red', pending: 'badge--yellow' }[bkStatus] || 'badge--grey';
      const submittedAt = k.submitted_at || k.submitted_date || k.created_at || '';
      const submittedLabel = submittedAt ? `<span style="display:block;margin-top:2px;font-size:0.68rem;color:var(--text-dim)"><i class="fa-solid fa-clock" style="margin-right:3px"></i>Submitted ${Utils.date(submittedAt)}</span>` : '';
      docTypeCell = `${_subAcctBadge}<div style="font-size:0.78rem;font-weight:700;color:var(--text);margin-bottom:4px">Proof of Bank</div>
        <div style="font-size:0.72rem;color:var(--text-muted);line-height:1.6">
          <span style="display:block"><strong>${bankName}</strong></span>
          <span style="display:block">${bankHolder} &bull; ${masked}</span>
          <span style="display:block">${acctType} &bull; Branch ${branchCode}</span>
          ${submittedLabel}
          <span class="badge ${bkCls}" style="font-size:0.62rem;margin-top:4px">Bank ${bkStatus}</span>
          <button class="btn btn--secondary" style="font-size:0.65rem;padding:2px 8px;margin-top:4px;display:inline-flex;align-items:center;gap:4px" onclick="event.stopPropagation();_showBankDetailsModal('${kInv.id}','${submittedAt}','${_esc(_saDocName)}')"><i class="fa-solid fa-eye"></i> View Full</button>
        </div>`;
    }

    // Expiry cell with warning colours
    const kExpLabel = kExpDate
      ? (kDaysToExp < 0
          ? `<div style="font-size:0.68rem;margin-top:2px;color:#ef4444;font-weight:600"><i class="fa-solid fa-calendar-xmark" style="margin-right:2px"></i>Expired ${Math.abs(kDaysToExp)}d ago</div>`
          : kDaysToExp < 30
            ? `<div style="font-size:0.68rem;margin-top:2px;color:#fec24f;font-weight:600"><i class="fa-solid fa-calendar-exclamation" style="margin-right:2px"></i>Expires in ${kDaysToExp}d</div>`
            : `<div style="font-size:0.68rem;margin-top:2px;color:#9ca3af"><i class="fa-solid fa-calendar-xmark" style="margin-right:2px"></i>Exp: ${Utils.date(k.expiry_date)}</div>`)
      : '';

    // Notes indicator
    const hasNotes = !!(k.notes && k.status !== 'rejected');
    const notesIndicator = hasNotes
      ? `<span title="${_esc(k.notes)}" style="display:inline-flex;align-items:center;gap:3px;font-size:0.65rem;color:#eda5ff;background:rgba(237,165,255,0.1);border-radius:4px;padding:1px 5px;cursor:pointer" onclick='openKycReview(${JSON.stringify(k.id)})'><i class="fa-solid fa-note-sticky"></i></span>`
      : '';

    return `
    <tr style="transition:background .15s${kRowExpiryStyle}">
      <td><input type="checkbox" class="kyc-cb" value="${k.id}" ${!canSelect ? 'disabled' : ''} ${_kycSelected.has(k.id) ? 'checked' : ''} onchange="toggleKycRow('${k.id}', this.checked)" style="${canSelect ? 'cursor:pointer;width:16px;height:16px;accent-color:#fec24f' : 'opacity:0.3;width:16px;height:16px'}"></td>
      <td><div class="td-strong clip">${kName} ${notesIndicator}</div><div class="td-muted clip">${k.investor_id}</div>${_isSubAcctDoc ? `<div style="margin-top:3px"><span style="font-size:0.62rem;font-weight:700;color:#eda5ff;background:rgba(237,165,255,0.1);border:1px solid rgba(237,165,255,0.25);border-radius:4px;padding:1px 5px"><i class="fa-solid fa-layer-group" style="margin-right:3px;font-size:0.58rem"></i>Sub Account</span></div>` : ''}</td>
      <td>${docTypeCell}</td>
      <td class="td-muted clip">${k.file_name || 'Not uploaded'}</td>
      <td>${Utils.statusBadge(k.status)}</td>
      <td class="td-muted">${Utils.date(k.submitted_at || k.submitted_date || k.created_at)}${kExpLabel}</td>
      <td>
        ${k.file_data || k.file_url || k.attachment_data
          ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
               <button class="btn btn--secondary btn--sm" title="Side-by-side review" onclick='openKycReview(${JSON.stringify(k.id)})'><i class="fa-solid fa-magnifying-glass"></i></button>
               <button class="btn btn--secondary btn--sm" title="Open document in new tab" onclick='viewFicaDocument(${JSON.stringify(k.id)})'><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
             </div>`
          : k.file_name
            ? `<span class="td-muted" style="font-size:0.72rem;line-height:1.4">No file data<br><span style="font-size:0.65rem;color:var(--text-dim)">Investor must re-upload</span></span>`
            : `<span class="td-muted" style="font-size:0.72rem">No file</span>`}
      </td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:nowrap;align-items:center">
          ${k.status === 'under_review' || k.status === 'pending' ? `
            <button class="btn btn--success btn--sm" title="Approve document" onclick='approveKyc(${JSON.stringify(k.id)}, this)'><i class="fa-solid fa-check"></i></button>
            <button class="btn btn--danger btn--sm" title="Reject document" onclick='rejectKyc(${JSON.stringify(k.id)}, this)'><i class="fa-solid fa-xmark"></i></button>
            <button class="btn btn--secondary btn--sm" title="Upload document for investor" onclick='openKycUploadModal(${JSON.stringify(k.investor_id)},${JSON.stringify(kName)})'><i class="fa-solid fa-upload"></i></button>
          ` : `<span class="td-muted" style="font-size:0.75rem">${Utils.date(k.reviewed_date || k.reviewed_at)}</span>`}
          <button class="btn btn--secondary btn--sm" title="Add/view reviewer notes" onclick='openKycReview(${JSON.stringify(k.id)})'><i class="fa-solid fa-note-sticky"></i></button>
          <button class="btn btn--secondary btn--sm" title="View KYC timeline" onclick='openKycTimeline(${JSON.stringify(k.investor_id)})'><i class="fa-solid fa-timeline"></i></button>
        </div>
      </td>
    </tr>
  `}).join('');
}

/** Show a full (unmasked) bank details modal for a KYC bank-doc row. */
function _showBankDetailsModal(investorId, submittedAt, saName) {
  const inv = STATE.investors.find(i => i.id === investorId);
  if (!inv) { Toast.error('Investor record not found.'); return; }

  const bkStatus = inv.bank_account_status || 'pending';
  const bkCls    = { approved: 'badge--green', rejected: 'badge--red', pending: 'badge--yellow' }[bkStatus] || 'badge--grey';

  const subtitle = document.getElementById('bankDetailSubtitle');
  if (subtitle) {
    const parts = [];
    if (saName) parts.push(`Sub Account: ${saName}`);
    if (submittedAt) parts.push(`Submitted ${Utils.date(submittedAt)}`);
    subtitle.textContent = parts.join(' · ');
  }

  const body = document.getElementById('bankDetailsBody');
  if (!body) return;

  const row = (label, value, mono) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:0.78rem;color:var(--text-dim);font-weight:600">${label}</span>
      <span style="font-size:0.88rem;font-weight:700;color:var(--text);${mono ? 'font-family:monospace;letter-spacing:0.04em' : ''}">${value || '—'}</span>
    </div>`;

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <span class="badge ${bkCls}">Bank ${bkStatus}</span>
      ${saName ? `<span style="font-size:0.72rem;font-weight:700;color:#eda5ff;background:rgba(237,165,255,0.12);border:1px solid rgba(237,165,255,0.3);border-radius:6px;padding:2px 8px"><i class="fa-solid fa-layer-group" style="margin-right:4px;font-size:0.65rem"></i>Sub Account: ${_esc(saName)}</span>` : ''}
    </div>
    ${row('Account Holder', _esc(inv.bank_account_holder || '—'))}
    ${row('Bank', _esc(inv.bank_name || '—'))}
    ${row('Account Number', _esc(inv.bank_account_number || '—'), true)}
    ${row('Account Type', _esc(inv.bank_account_type || '—'))}
    ${row('Branch Code', _esc(inv.bank_branch_code || '—'), true)}
    ${inv.bank_account_notes ? `<div style="margin-top:12px;padding:10px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:0.78rem;color:#fca5a5"><strong>Notes:</strong> ${_esc(inv.bank_account_notes)}</div>` : ''}
    <div style="margin-top:16px;display:flex;gap:8px">
      <button class="btn btn--secondary btn--sm" onclick="viewBankProof('${investorId}')"><i class="fa-solid fa-file"></i> Open Document</button>
      <button class="btn btn--secondary btn--sm" onclick="Modal.close('bankDetailsModal')">Close</button>
    </div>`;

  Modal.open('bankDetailsModal');
}

/** Fetch and open an investor's most recent proof-of-bank document (admin profile view). */
async function viewBankProof(investorId) {
  try {
    const res = await API.kyc.list({ investor_id: investorId, limit: 200 });
    const proofs = (res.data || [])
      .filter(d => d.doc_type === 'proof_of_bank' && (d.file_data || d.attachment_data || d.file_url || d.file_name))
      .sort((a, b) => new Date(b.submitted_at || b.created_at || 0) - new Date(a.submitted_at || a.created_at || 0));
    if (!proofs.length) { Toast.error('No proof of bank account uploaded for this investor.'); return; }
    const proof = proofs[0];
    let fileData = proof.file_data || proof.attachment_data || proof.file_url || '';
    if (!fileData) {
      const full = await API.kyc.get(proof.id).catch(() => null);
      fileData = full?.file_data || full?.attachment_data || full?.file_url || '';
    }
    if (!fileData) { Toast.error('File data not stored — please ask the investor to re-upload their proof of bank.'); return; }
    _openDocumentData(fileData, proof.file_name || 'Proof of Bank');
  } catch (e) {
    Toast.error('Could not load proof of bank: ' + (e.message || 'unknown error'));
  }
}

async function _runBankAutoVerify(investorId) {
  const resultEl = document.getElementById('bankVerifyResult');
  const btn      = document.getElementById('bankAutoVerifyBtn');
  if (!resultEl || !btn) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…';
  resultEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem"><i class="fa-solid fa-spinner fa-spin"></i> Sending document to AI for analysis…</span>';

  try {
    const r = await API._fetch('POST', `admin/bank-verify/${investorId}`, {});

    const verdictCfg = {
      match:       { icon: 'fa-circle-check',   color: '#22c55e', label: 'Details Match',          bg: 'rgba(34,197,94,0.08)',   border: 'rgba(34,197,94,0.25)'   },
      partial:     { icon: 'fa-circle-exclamation', color: '#fec24f', label: 'Partial Match',      bg: 'rgba(254,194,79,0.08)',  border: 'rgba(254,194,79,0.25)'  },
      mismatch:    { icon: 'fa-circle-xmark',   color: '#ef4444', label: 'Details Do Not Match',   bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)'   },
      unreadable:  { icon: 'fa-file-circle-question', color: '#9ca3af', label: 'Document Unreadable', bg: 'rgba(156,163,175,0.08)', border: 'rgba(156,163,175,0.25)' },
    };
    const vc = verdictCfg[r.verdict] || verdictCfg.unreadable;

    const rows = Object.entries(r.checks || {}).map(([, c]) => {
      const statusIcon = c.status === 'match'    ? '<i class="fa-solid fa-check" style="color:#22c55e"></i>'
                       : c.status === 'mismatch' ? '<i class="fa-solid fa-xmark" style="color:#ef4444"></i>'
                       : '<i class="fa-solid fa-minus" style="color:#9ca3af"></i>';
      const extracted = c.extracted || '<span style="color:#9ca3af;font-style:italic">not found</span>';
      return `<tr>
        <td style="padding:5px 8px;font-weight:600;white-space:nowrap">${_esc(c.label)}</td>
        <td style="padding:5px 8px">${_esc(c.submitted || '—')}</td>
        <td style="padding:5px 8px">${typeof extracted === 'string' && extracted.startsWith('<') ? extracted : _esc(extracted)}</td>
        <td style="padding:5px 8px;text-align:center">${statusIcon}</td>
      </tr>`;
    }).join('');

    resultEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${vc.bg};border:1px solid ${vc.border};border-radius:8px;margin-bottom:10px">
        <i class="fa-solid ${vc.icon}" style="color:${vc.color};font-size:1.1rem"></i>
        <div style="flex:1">
          <div style="font-weight:700;font-size:0.85rem;color:${vc.color}">${vc.label}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Confidence: ${r.confidence ?? '—'}% · Doc: ${_esc(r.docName || 'proof_of_bank')}</div>
        </div>
        ${r.verdict === 'match' || r.verdict === 'partial'
          ? `<button class="btn btn--success btn--sm" onclick="document.getElementById('ticketApproveBtn')?.click()"><i class="fa-solid fa-check"></i> Approve</button>`
          : r.verdict === 'mismatch'
          ? `<button class="btn btn--danger btn--sm" onclick="document.getElementById('ticketDeclineBtn')?.click()"><i class="fa-solid fa-xmark"></i> Decline</button>`
          : ''}
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
          <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted)">
            <th style="padding:4px 8px;text-align:left;font-weight:700">Field</th>
            <th style="padding:4px 8px;text-align:left;font-weight:700">Submitted</th>
            <th style="padding:4px 8px;text-align:left;font-weight:700">In Document</th>
            <th style="padding:4px 8px;text-align:center;font-weight:700">✓</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    const msg = e.message || 'Unknown error';
    resultEl.innerHTML = `<div style="color:#ef4444;font-size:0.82rem"><i class="fa-solid fa-triangle-exclamation"></i> ${_esc(msg)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Auto-Verify';
  }
}

async function viewFicaDocument(kycId) {
  const doc = STATE.kyc.find(k => k.id === kycId);
  if (!doc) return;
  let fileData = doc.file_data || doc.attachment_data || doc.file_url || '';
  if (!fileData) {
    try {
      const full = await API.kyc.get(kycId);
      fileData = full?.file_data || full?.attachment_data || full?.file_url || '';
    } catch (_) {}
  }
  if (!fileData) {
    Toast.error('File data not stored — please ask the investor to re-upload their document.');
    return;
  }
  _openDocumentData(fileData, doc.file_name || 'Document');
}

/** Convert a data: URL to a Blob, returns null on failure. */
function _dataUrlToBlob(dataUrl) {
  try {
    const mime = dataUrl.split(',')[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
    const b64  = dataUrl.split(',')[1];
    const bin  = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (_) { return null; }
}

/** Open a base64 data URL / HTTP URL document in a new tab (with download fallback). */
function _openDocumentData(rawData, fileName) {
  fileName = fileName || 'Document';

  if (!rawData) {
    Toast.error('No file attached to this document record.');
    return;
  }

  const isDataUrl = rawData.startsWith('data:');
  const isHttpUrl = rawData.startsWith('https://') || rawData.startsWith('http://');

  if (isHttpUrl) {
    // HTTP URLs: open directly in new tab
    window.open(rawData, '_blank', 'noopener,noreferrer');
    return;
  }

  if (isDataUrl) {
    // Determine MIME type before entering try/catch so it's accessible in the catch block
    const mime = rawData.split(',')[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
    const isPdf = mime === 'application/pdf' || (fileName || '').toLowerCase().endsWith('.pdf');

    try {
      const b64 = rawData.split(',')[1];
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      const w = window.open(blobUrl, '_blank', 'noopener');
      if (!w) {
        // Popup blocked — download as blob URL instead
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        a.click();
      }
    } catch (e) {
      // atob/Blob failed — write data URL directly into a new window
      const w = window.open('', '_blank');
      if (w) {
        w.document.write(isPdf
          ? `<title>${_esc(fileName)}</title><body style="margin:0;height:100vh"><embed src="${rawData}" type="application/pdf" style="width:100%;height:100%"></body>`
          : `<title>${_esc(fileName)}</title><body style="margin:0;background:#000"><img src="${rawData}" style="max-width:100%;display:block;margin:auto"></body>`
        );
      }
    }
    return;
  }

  // Unknown format — download
  const a = document.createElement('a');
  a.href = rawData;
  a.download = fileName;
  a.click();
}

function _openTicketDoc(ticketId, fileName) {
  const data = _ticketDocCache[ticketId];
  if (!data) { Toast.error('No file data available. Please ask the investor to re-upload.'); return; }
  _openDocumentData(data, fileName);
}

function _downloadTicketDoc(ticketId, fileName) {
  const data = _ticketDocCache[ticketId];
  if (!data) { Toast.error('No file data available.'); return; }
  const a = document.createElement('a');
  a.href = data;
  a.download = fileName || 'attachment';
  a.click();
}

async function _reuploadTicketFile(event, ticketId) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const dataUrl = e.target.result;
    try {
      await API._fetch('PATCH', `tables/support_tickets/${ticketId}`, {
        file_url:       dataUrl,
        proof_filename: file.name,
        proof_attached: true,
      });
      _ticketDocCache[ticketId] = dataUrl;
      Toast.success('Document re-uploaded — click View to open it');
      viewTicket(ticketId);
    } catch (err) {
      Toast.error('Re-upload failed: ' + err.message);
    }
  };
  reader.readAsDataURL(file);
}

// FICA/KYC is only fully verified once ALL of these document types are approved.
const FICA_REQUIRED_DOCS = ['id_document', 'proof_of_address', 'proof_of_bank'];
const FICA_DOC_LABELS = {
  id_document: 'ID', proof_of_address: 'Proof of Address', proof_of_bank: 'Proof of Bank Details',
};

/**
 * Recompute an investor's overall FICA/KYC status from their documents.
 * Verified only when ID + Proof of Address + Proof of Bank Details are all approved.
 * Otherwise the status is "in_progress" (documents check pending).
 * Returns { verified, missing: [labels] }.
 */
async function _recomputeInvestorFicaStatus(investorId) {
  if (!investorId) return { verified: false, missing: [] };
  let docs = [];
  try {
    const res = await API.kyc.list({ investor_id: investorId, limit: 200 });
    docs = res.data || [];
  } catch (_) { return { verified: false, missing: [] }; }

  const approvedTypes = new Set(docs.filter(d => d.status === 'approved').map(d => d.doc_type));
  const missing = FICA_REQUIRED_DOCS.filter(t => !approvedTypes.has(t));
  const verified = missing.length === 0;

  if (verified) {
    await API._fetch('PATCH', `tables/investors/${investorId}`, { kyc_status: 'approved', fica_status: 'approved', status: 'active' });
  } else {
    await API._fetch('PATCH', `tables/investors/${investorId}`, { kyc_status: 'pending', fica_status: 'submitted' });
  }
  return { verified, missing: missing.map(t => FICA_DOC_LABELS[t] || t) };
}

async function _recomputeSubAccountFicaStatus(saId) {
  if (!saId) return { verified: false };
  const docs = (STATE.kyc || []).filter(d => d.sub_account_id === saId);
  const idDocApproved = docs.some(d => d.doc_type === 'id_document' && d.status === 'approved');
  const sa = (STATE.subAccounts || []).find(s => s.id === saId);
  const bankApproved = sa?.sa_bank_status === 'approved';
  const verified = idDocApproved && bankApproved;
  if (verified) {
    await API._fetch('PATCH', `tables/sub_accounts/${saId}`, { kyc_status: 'approved' });
    if (sa) sa.kyc_status = 'approved';
  }
  return { verified };
}

async function approveKyc(id, btn) {
  if (!await Confirm.ask('Approve KYC document?', { body: 'This will mark the document as verified.', confirmLabel: 'Approve' })) return;
  const reviewedBy = _getAdminName();
  await _withBtn(btn, async () => {
    try {
      await API.kyc.update(id, { status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() });
      const doc = STATE.kyc.find(k => k.id === id);

      if (doc?.sub_account_id) {
        // Sub-account document
        if (doc.doc_type === 'proof_of_bank') {
          await API._fetch('PATCH', `tables/sub_accounts/${doc.sub_account_id}`, { sa_bank_status: 'approved' });
          const sa = (STATE.subAccounts || []).find(s => s.id === doc.sub_account_id);
          if (sa) sa.sa_bank_status = 'approved';
        }
        const saResult = await _recomputeSubAccountFicaStatus(doc.sub_account_id);
        Toast.success(saResult.verified
          ? 'Document approved — sub-account is now FICA-verified'
          : 'Document approved for sub-account');
      } else {
        // Regular investor document
        if (doc?.investor_id && doc?.doc_type === 'proof_of_bank') {
          await API._fetch('PATCH', `tables/investors/${doc.investor_id}`, { bank_account_status: 'approved', bank_account_notes: null });
        }
        const result = await _recomputeInvestorFicaStatus(doc?.investor_id);
        Toast.success(result.verified
          ? 'Document approved — investor is now FICA-verified'
          : `Document approved — still needed: ${result.missing.join(', ')}`);
      }
      await loadKYC();
    } catch (e) {
      Toast.error('Failed to approve document: ' + (e.message || 'unknown error'));
      console.error('[approveKyc]', e);
    }
  });
}

function rejectKyc(id, btn) {
  if (!id) { Toast.error('Invalid document ID'); return; }
  _rejectingKycId = id;
  _rejectingTxnId = null;
  _rejectMode = 'kyc';
  _rejectBtn = btn;
  document.getElementById('rejectModalTitle').textContent = 'Reject KYC Document';
  document.getElementById('rejectModalBody').textContent = 'The document will be marked as rejected. Provide a reason for the investor (optional).';
  document.getElementById('rejectReasonInput').value = '';
  const tpl = document.getElementById('kycRejectTemplates');
  if (tpl) tpl.style.display = '';
  const emailRow = document.getElementById('kycRejectEmailRow');
  if (emailRow) emailRow.style.display = '';
  const emailCb = document.getElementById('kycRejectEmailInvestor');
  if (emailCb) emailCb.checked = true;
  const overlay = document.getElementById('rejectModal');
  overlay.style.display = 'flex';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('rejectReasonInput')?.focus(), 100);
}

/* ═══════════════════════════════════════════════
   KYC SIDE-BY-SIDE REVIEW
   ═══════════════════════════════════════════════ */
let _reviewingKycId = null;

async function openKycReview(id) {
  const cached = STATE.kyc.find(k => k.id === id);
  if (!cached) return;
  _reviewingKycId = id;

  // Open modal immediately with metadata (no file yet)
  const overlay = document.getElementById('kycReviewModal');
  if (overlay) { overlay.style.display = 'flex'; overlay.classList.add('open'); document.body.style.overflow = 'hidden'; }

  const docContent = document.getElementById('kycReviewDocContent');
  if (docContent) docContent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin" style="margin-right:8px"></i>Loading document…</div>';

  // Fetch the full record (includes file_data which is excluded from the list query)
  let doc = cached;
  try {
    const full = await API.kyc.get(id);
    if (full && full.id) doc = { ...cached, ...full };
  } catch (_) {}

  const inv = STATE.investors.find(i => i.id === doc.investor_id);
  const invName = doc.investor_name || (inv ? `${inv.first_name} ${inv.last_name}`.trim() : doc.investor_id || '—');

  // --- Document pane ---
  if (docContent) {
    docContent._zoom = 1;
    const _zoomBar = () => `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 10px;background:rgba(0,0,0,0.35);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0">
        <button class="btn btn--ghost btn--sm" onclick="_docZoom(-0.25)" title="Zoom out" style="padding:3px 7px"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
        <span id="docZoomLabel" style="font-size:0.75rem;color:var(--text-muted);min-width:40px;text-align:center">100%</span>
        <button class="btn btn--ghost btn--sm" onclick="_docZoom(0.25)" title="Zoom in" style="padding:3px 7px"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
        <button class="btn btn--ghost btn--sm" onclick="_docZoom(0)" title="Reset to fit" style="padding:3px 8px;font-size:0.72rem">Fit</button>
      </div>`;
    const _dlBtn = (href, filename, isExternal) => `
      <div style="padding:8px 12px;background:rgba(0,0,0,0.25);border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:8px;flex-shrink:0">
        <a href="${href}" ${isExternal ? 'target="_blank" rel="noopener"' : `download="${_esc(filename||'document')}"`}
           class="btn btn--secondary btn--sm" style="font-size:0.78rem">
          <i class="fa-solid ${isExternal ? 'fa-external-link' : 'fa-download'}"></i>
          ${isExternal ? 'Open in new tab' : 'Download'} ${_esc(filename ? '— ' + filename : '')}
        </a>
      </div>`;

    if (doc.file_data) {
      const mime = doc.file_data.startsWith('data:') ? doc.file_data.split(';')[0].replace('data:', '') : '';
      const fname = doc.file_name || 'document';
      if (mime.startsWith('image/')) {
        docContent.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%">
            ${_zoomBar()}
            <div style="flex:1;overflow:auto;display:flex;justify-content:center;padding:12px">
              <div id="docZoomTarget" style="transition:transform 0.15s;transform-origin:top center">
                <img src="${doc.file_data}" style="max-width:100%;border-radius:8px;display:block">
              </div>
            </div>
            ${_dlBtn(doc.file_data, fname, false)}
          </div>`;
      } else if (mime === 'application/pdf') {
        // Browsers block data: URIs in iframes — convert to a blob URL instead
        const b64 = doc.file_data.split(',')[1];
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        docContent._pdfBlobUrl = blobUrl;
        docContent.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%">
            ${_zoomBar()}
            <div style="flex:1;overflow:auto">
              <div id="docZoomTarget" style="transition:transform 0.15s;transform-origin:top center">
                <iframe src="${blobUrl}" style="width:100%;height:800px;border:none;display:block"></iframe>
              </div>
            </div>
            ${_dlBtn(doc.file_data, fname, false)}
          </div>`;
      } else {
        docContent.innerHTML = `<div style="text-align:center;padding:40px"><a href="${doc.file_data}" download="${_esc(fname)}" class="btn btn--primary"><i class="fa-solid fa-download"></i> Download Document</a><p style="margin-top:12px;font-size:0.8rem;color:var(--text-muted)">${_esc(fname)}</p></div>`;
      }
    } else if (doc.file_url) {
      const isImg = /\.(jpg|jpeg|png|gif|webp)$/i.test(doc.file_url);
      const isPDF = /\.pdf$/i.test(doc.file_url);
      const fname = doc.file_name || doc.file_url.split('/').pop() || 'document';
      if (isImg) {
        docContent.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%">
            ${_zoomBar()}
            <div style="flex:1;overflow:auto;display:flex;justify-content:center;padding:12px">
              <div id="docZoomTarget" style="transition:transform 0.15s;transform-origin:top center">
                <img src="${doc.file_url}" style="max-width:100%;border-radius:8px;display:block">
              </div>
            </div>
            ${_dlBtn(doc.file_url, fname, true)}
          </div>`;
      } else if (isPDF) {
        docContent.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%">
            ${_zoomBar()}
            <div style="flex:1;overflow:auto">
              <div id="docZoomTarget" style="transition:transform 0.15s;transform-origin:top center">
                <iframe src="${doc.file_url}" style="width:100%;height:800px;border:none;display:block"></iframe>
              </div>
            </div>
            ${_dlBtn(doc.file_url, fname, true)}
          </div>`;
      } else {
        docContent.innerHTML = `<div style="text-align:center;padding:40px"><a href="${doc.file_url}" target="_blank" rel="noopener" class="btn btn--primary"><i class="fa-solid fa-external-link"></i> Open Document</a></div>`;
      }
    } else {
      docContent.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--text-muted)"><i class="fa-solid fa-file-circle-question fa-3x" style="opacity:0.3;display:block;margin-bottom:12px"></i><div>No file attached</div><div style="font-size:0.78rem;margin-top:6px">The investor has not uploaded a file for this document.</div></div>`;
    }
  }

  // --- Details pane ---
  const DOC_LABELS = { id_document: 'Identity Document', proof_of_address: 'Proof of Address', proof_of_bank: 'Proof of Bank Account', other: 'Other Document' };
  const docTypeLabel = DOC_LABELS[doc.doc_type] || doc.doc_type?.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) || '—';
  const expDate = doc.expiry_date ? new Date(doc.expiry_date) : null;
  const daysToExp = expDate ? Math.round((expDate - new Date()) / 86400000) : null;
  const expHtml = expDate ? `<div style="margin-top:5px;font-size:0.75rem;font-weight:600;color:${daysToExp < 0 ? '#ef4444' : daysToExp < 30 ? '#fec24f' : '#22c55e'}"><i class="fa-solid fa-calendar-xmark" style="margin-right:4px"></i>${daysToExp < 0 ? `Expired ${Math.abs(daysToExp)} days ago` : `Expires in ${daysToExp} days`}</div>` : '';

  const detailsEl = document.getElementById('kycReviewDetails');
  if (detailsEl) detailsEl.innerHTML = `
    <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:0.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:5px">Investor</div>
      <div style="font-weight:700;font-size:0.92rem">${_esc(invName)}</div>
      ${inv?.email ? `<div style="font-size:0.75rem;color:var(--text-muted)">${_esc(inv.email)}</div>` : ''}
      ${inv?.id_number ? `<div style="font-size:0.75rem;color:var(--text-muted)">ID: ${_esc(inv.id_number)}</div>` : ''}
      ${inv?.phone ? `<div style="font-size:0.75rem;color:var(--text-muted)">Tel: ${_esc(inv.phone)}</div>` : ''}
    </div>
    <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:0.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:5px">Document</div>
      <div style="font-weight:700;font-size:0.85rem">${docTypeLabel}</div>
      ${doc.doc_subtype ? `<div style="font-size:0.72rem;color:var(--text-muted)">${doc.doc_subtype}</div>` : ''}
      <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px">Submitted: ${Utils.date(doc.submitted_at || doc.created_at)}</div>
      <div style="font-size:0.72rem;color:var(--text-muted)">File: ${_esc(doc.file_name || '—')}</div>
      ${expHtml}
    </div>
    <div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:0.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:5px">Status</div>
      ${Utils.statusBadge(doc.status)}
      ${doc.reviewed_by ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:5px">Reviewed by: ${_esc(doc.reviewed_by)}</div>` : ''}
      ${doc.reviewed_at ? `<div style="font-size:0.72rem;color:var(--text-muted)">Reviewed: ${Utils.date(doc.reviewed_at)}</div>` : ''}
    </div>
    <div>
      <div style="font-size:0.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:5px">Reviewer Notes</div>
      <textarea id="kycReviewNotes" class="form-input" rows="4" placeholder="Internal notes (not shown to investor)…" style="width:100%;resize:vertical;font-size:0.82rem">${_esc(doc.notes || '')}</textarea>
      <button class="btn btn--secondary btn--sm" style="margin-top:6px;width:100%" onclick="_saveKycReviewNotes()"><i class="fa-solid fa-floppy-disk"></i> Save Notes</button>
    </div>`;

  // --- Actions pane ---
  const actionsEl = document.getElementById('kycReviewActions');
  const canReview = ['pending','under_review'].includes(doc.status);
  if (actionsEl) {
    actionsEl.innerHTML = canReview
      ? `<div style="display:flex;gap:8px">
           <button class="btn btn--success" style="flex:1" onclick="_kycReviewApprove()"><i class="fa-solid fa-check"></i> Approve</button>
           <button class="btn btn--danger" style="flex:1" onclick="_kycReviewReject()"><i class="fa-solid fa-xmark"></i> Reject</button>
         </div>`
      : `<div style="text-align:center;font-size:0.8rem;color:var(--text-muted);padding:4px 0">Document already ${doc.status}.<br>Change status via the KYC queue.</div>`;
  }

}

function closeKycReview() {
  const overlay = document.getElementById('kycReviewModal');
  if (overlay) { overlay.style.display = 'none'; overlay.classList.remove('open'); }
  document.body.style.overflow = '';
  _reviewingKycId = null;
  const docContent = document.getElementById('kycReviewDocContent');
  if (docContent?._pdfBlobUrl) { URL.revokeObjectURL(docContent._pdfBlobUrl); docContent._pdfBlobUrl = null; }
  docContent._zoom = 1;
}

function _docZoom(delta) {
  const docContent = document.getElementById('kycReviewDocContent');
  if (!docContent) return;
  docContent._zoom = delta === 0 ? 1 : Math.min(4, Math.max(0.25, (docContent._zoom || 1) + delta));
  const target = document.getElementById('docZoomTarget');
  if (target) { target.style.transform = `scale(${docContent._zoom})`; target.style.transformOrigin = 'top center'; }
  const label = document.getElementById('docZoomLabel');
  if (label) label.textContent = Math.round(docContent._zoom * 100) + '%';
}

async function _saveKycReviewNotes() {
  const id = _reviewingKycId;
  if (!id) return;
  const notes = document.getElementById('kycReviewNotes')?.value || '';
  try {
    await API.kyc.update(id, { notes });
    Toast.success('Notes saved');
    const doc = STATE.kyc.find(k => k.id === id);
    if (doc) doc.notes = notes;
  } catch (e) { Toast.error('Failed to save notes: ' + e.message); }
}

async function _kycReviewApprove() {
  const id = _reviewingKycId;
  if (!id) return;
  if (!await Confirm.ask('Approve KYC document?', { body: 'This will mark the document as verified.', confirmLabel: 'Approve' })) return;
  const reviewedBy = _getAdminName();
  try {
    // Save any notes first
    const notes = document.getElementById('kycReviewNotes')?.value || '';
    await API.kyc.update(id, { status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), notes: notes || undefined });
    const doc = STATE.kyc.find(k => k.id === id);
    if (doc) doc.notes = notes;
    if (doc?.investor_id && doc?.doc_type === 'proof_of_bank' && !doc.sub_account_id) {
      await API._fetch('PATCH', `tables/investors/${doc.investor_id}`, { bank_account_status: 'approved', bank_account_notes: null });
    }
    const result = await _recomputeInvestorFicaStatus(doc?.investor_id);
    Toast.success(result.verified ? 'Approved — investor is now FICA-verified' : `Approved — still needed: ${result.missing.join(', ')}`);
    closeKycReview();
    await loadKYC();
  } catch (e) { Toast.error('Failed to approve: ' + e.message); }
}

async function _kycReviewReject() {
  const id = _reviewingKycId;
  if (!id) return;
  // Save notes before closing review modal, then open reject modal
  const notes = document.getElementById('kycReviewNotes')?.value || '';
  if (notes) {
    try { await API.kyc.update(id, { notes }); const doc = STATE.kyc.find(k => k.id === id); if (doc) doc.notes = notes; } catch (_) {}
  }
  closeKycReview();
  rejectKyc(id, null);
}

/* ═══════════════════════════════════════════════
   KYC TIMELINE (PER INVESTOR)
   ═══════════════════════════════════════════════ */
function openKycTimeline(investorId) {
  const inv = STATE.investors.find(i => i.id === investorId);
  const invName = inv ? `${inv.first_name} ${inv.last_name}`.trim() : investorId || '—';
  const titleEl = document.getElementById('kycTimelineTitle');
  if (titleEl) titleEl.textContent = `KYC Timeline — ${invName}`;

  const docs = (STATE.kyc || []).filter(k => k.investor_id === investorId).sort((a, b) =>
    new Date(a.submitted_at || a.created_at || 0) - new Date(b.submitted_at || b.created_at || 0)
  );

  const DOC_LABELS = { id_document: 'Identity Document', proof_of_address: 'Proof of Address', proof_of_bank: 'Proof of Bank Account', other: 'Other' };
  const DOC_ICONS  = { id_document: 'fa-id-card', proof_of_address: 'fa-house', proof_of_bank: 'fa-building-columns', other: 'fa-file' };
  const STATUS_COLORS = { pending: '#fec24f', under_review: '#60a5fa', approved: '#22c55e', rejected: '#ef4444' };

  // Build timeline events from KYC docs
  const events = [];
  for (const doc of docs) {
    const dt = doc.doc_type;
    const label = DOC_LABELS[dt] || dt?.replace(/_/g,' ') || 'Document';
    const icon = DOC_ICONS[dt] || 'fa-file';
    if (doc.submitted_at || doc.created_at) {
      events.push({ date: doc.submitted_at || doc.created_at, icon, color: '#fec24f', title: `${label} submitted`, body: doc.file_name || '' });
    }
    if (doc.reviewed_at || doc.reviewed_date) {
      const revDate = doc.reviewed_at || doc.reviewed_date;
      const revColor = STATUS_COLORS[doc.status] || '#9ca3af';
      const statusLabel = { pending: 'Pending', under_review: 'Under Review', approved: 'Approved', rejected: 'Rejected' }[doc.status] || doc.status;
      events.push({ date: revDate, icon, color: revColor, title: `${label} ${statusLabel}`, body: doc.reviewed_by ? `Reviewed by ${doc.reviewed_by}` : '', notes: doc.notes && doc.status !== 'rejected' ? null : doc.notes });
    }
  }
  events.sort((a, b) => new Date(b.date) - new Date(a.date));

  const contentEl = document.getElementById('kycTimelineContent');
  if (!contentEl) return;

  if (!events.length) {
    const ficaStatus = inv?.fica_status || 'not_started';
    contentEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <i class="fa-solid fa-clock fa-2x" style="opacity:0.25;display:block;margin-bottom:12px"></i>
      <div style="font-weight:600">${invName} has not submitted any KYC documents yet.</div>
      <div style="margin-top:8px;font-size:0.8rem">FICA status: <strong>${ficaStatus}</strong></div>
    </div>`;
  } else {
    // Summary badges at top
    const approvedCount = docs.filter(d => d.status === 'approved').length;
    const REQUIRED = 3;
    const pct = Math.round(approvedCount / REQUIRED * 100);
    contentEl.innerHTML = `
      <div style="margin-bottom:16px;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">FICA Progress</span>
          <span style="font-size:0.78rem;font-weight:700;color:${approvedCount >= REQUIRED ? '#22c55e' : '#fec24f'}">${approvedCount}/${REQUIRED} docs approved</span>
        </div>
        <div style="height:5px;background:rgba(255,255,255,0.07);border-radius:3px">
          <div style="height:100%;width:${pct}%;background:${approvedCount >= REQUIRED ? '#22c55e' : '#fec24f'};border-radius:3px;transition:width .4s"></div>
        </div>
        ${inv?.fica_status ? `<div style="margin-top:8px;font-size:0.72rem;color:var(--text-muted)">FICA status: <strong style="color:${STATUS_COLORS[inv.fica_status] || '#7a92a8'}">${inv.fica_status}</strong></div>` : ''}
      </div>
      <div style="position:relative;padding-left:24px">
        <div style="position:absolute;left:9px;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.08)"></div>
        ${events.map(ev => `
          <div style="position:relative;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.04)">
            <div style="position:absolute;left:-19px;top:3px;width:10px;height:10px;border-radius:50%;background:${ev.color};box-shadow:0 0 0 2px rgba(255,255,255,0.06)"></div>
            <div style="font-size:0.68rem;color:var(--text-muted);margin-bottom:3px">${Utils.date(ev.date)}</div>
            <div style="font-weight:600;font-size:0.83rem;color:${ev.color}">${_esc(ev.title)}</div>
            ${ev.body ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${_esc(ev.body)}</div>` : ''}
            ${ev.notes ? `<div style="margin-top:5px;padding:6px 10px;background:rgba(239,68,68,0.06);border-left:2px solid rgba(239,68,68,0.4);border-radius:0 6px 6px 0;font-size:0.75rem;color:#f87171">${_esc(ev.notes)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }

  const overlay = document.getElementById('kycTimelineModal');
  if (overlay) { overlay.style.display = 'flex'; overlay.classList.add('open'); document.body.style.overflow = 'hidden'; }
}

function closeKycTimeline() {
  const overlay = document.getElementById('kycTimelineModal');
  if (overlay) { overlay.style.display = 'none'; overlay.classList.remove('open'); }
  document.body.style.overflow = '';
}

/* ═══════════════════════════════════════════════
   POOLS
   ═══════════════════════════════════════════════ */

// Capacity bar HTML helper
function _capacityBar(pool) {
  const max = Number(pool.max_capacity) || 0;
  const cur = Number(pool.current_invested) || 0;
  if (!max) return '<span style="font-size:0.75rem;color:var(--text-muted)">Unlimited</span>';
  const pct = Math.min(100, Math.round(cur / max * 100));
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#fec24f' : '#22c55e';
  const fullBadge = cur >= max ? ' <span style="display:inline-block;background:#ef4444;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 6px;border-radius:20px;vertical-align:middle;margin-left:4px">Full</span>' : '';
  return `<div style="min-width:100px">${fullBadge}
    <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;margin-bottom:3px">
      <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
    </div>
    <div style="font-size:0.68rem;color:var(--text-muted)">${pct}% · R${(cur/1000).toFixed(0)}k / R${(max/1000).toFixed(0)}k</div>
  </div>`;
}

/* ═══════════════════════════════════════════════
   PRODUCTS
   ═══════════════════════════════════════════════ */

// Average ACHIEVED return for a product = avg of actual_rate across all of its
// pools that have matured or been paid out (those with a real achieved rate).
function _productAvgReturn(productType) {
  const matured = (STATE.pools || []).filter(p =>
    p.product_type === productType &&
    ['matured', 'paid_out'].includes(p.status) &&
    (parseFloat(p.actual_rate) || 0) > 0
  );
  if (!matured.length) return null;
  const sum = matured.reduce((s, p) => s + (parseFloat(p.actual_rate) || 0), 0);
  return { rate: sum / matured.length, count: matured.length };
}

async function loadProducts() {
  try {
    // Pools power the auto-calculated average return
    if (!STATE.pools || !STATE.pools.length) {
      try { const pr = await API.pools.list({ limit: 200 }); STATE.pools = pr.data || []; } catch (_) {}
    }
    const res = await API.products.list({ limit: 200 });
    STATE.products = (res.data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    renderProductsGrid();
  } catch (e) { Toast.error('Failed to load products'); }
}

function renderProductsGrid() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;
  const products = STATE.products || [];
  if (!products.length) {
    grid.innerHTML = '<div class="text-center text-muted" style="grid-column:1/-1;padding:32px">No products yet. Click “New Product” to add one.</div>';
    return;
  }
  grid.innerHTML = products.map(p => {
    const avg = _productAvgReturn(p.product_type);
    const avgLabel = avg
      ? `${(avg.rate * 100).toFixed(2)}% p.a.`
      : '<span style="color:var(--text-muted)">No matured pools yet</span>';
    const avgSub = avg ? `avg of ${avg.count} matured pool${avg.count === 1 ? '' : 's'}` : 'awaiting maturity';
    return `
      <div class="pool-card">
        <div class="pool-card__header">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:10px;background:${p.color || '#656565'}22;color:${p.color || '#656565'};display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fa-solid ${p.icon || 'fa-box'}"></i></div>
            <div>
              <div class="pool-card__name">${p.label || p.product_type}</div>
              <div class="pool-card__partner">${p.product_type}${p.partner_name ? ' · ' + p.partner_name : ''}</div>
            </div>
          </div>
          ${p.is_active ? '<span class="badge badge--green">Active</span>' : '<span class="badge badge--gray">Hidden</span>'}
        </div>
        <div class="pool-card__stats">
          <div class="pool-stat"><span class="pool-stat__label">Avg Return</span><span class="pool-stat__value pool-stat__value--gold">${avgLabel}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Minimum</span><span class="pool-stat__value">${Utils.rand(p.min_investment || 0)}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Term</span><span class="pool-stat__value">${p.term_months || '—'}mo</span></div>
        </div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:6px">${avgSub}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px">
          <i class="fa-solid ${p.factsheet_url ? 'fa-file-pdf' : 'fa-file-circle-xmark'}" style="color:${p.factsheet_url ? '#ef4444' : 'var(--text-muted)'}"></i>
          ${p.factsheet_url ? (p.factsheet_name || 'Factsheet loaded') : 'No factsheet'}
          ${p.display_on_homepage ? ' · <i class="fa-solid fa-house"></i> on home page' : ''}
        </div>
        <div class="pool-card__actions">
          <button class="btn btn--secondary btn--sm flex-1" onclick='editProduct(${JSON.stringify(p.id)})'><i class="fa-solid fa-pen"></i> Edit</button>
          ${p.factsheet_url ? `<button class="btn btn--secondary btn--sm" onclick='_viewProductFactsheet(${JSON.stringify(p.id)})' title="View factsheet"><i class="fa-solid fa-file-pdf" style="color:#ef4444"></i></button>` : ''}
          ${p.factsheet_url ? `<button class="btn btn--secondary btn--sm" onclick='removeProductFactsheet(${JSON.stringify(p.id)})' title="Remove factsheet"><i class="fa-solid fa-file-circle-xmark" style="color:#ef4444"></i></button>` : ''}
          <button class="btn btn--secondary btn--sm" onclick='deleteProduct(${JSON.stringify(p.id)})' title="Delete"><i class="fa-solid fa-trash" style="color:#ef4444"></i></button>
        </div>
      </div>`;
  }).join('');
}

function _viewProductFactsheet(id) {
  const p = (STATE.products || []).find(x => x.id === id);
  if (!p || !p.factsheet_url) return;
  const raw = p.factsheet_url;
  if (raw.startsWith('http')) { window.open(raw, '_blank', 'noopener'); return; }
  try {
    const [header, b64] = raw.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'application/pdf';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(url, '_blank', 'noopener');
  } catch (_) { Toast.error('Could not open factsheet'); }
}

async function removeProductFactsheet(productId) {
  if (!await Confirm.ask('Remove factsheet?', { body: 'This removes the factsheet from this product and cannot be undone.', confirmLabel: 'Remove', danger: true })) return;
  try {
    await API.products.update(productId, { factsheet_url: null, factsheet_name: null });
    const p = (STATE.products || []).find(x => x.id === productId);
    if (p) { p.factsheet_url = null; p.factsheet_name = null; }
    const cur = document.getElementById('prodFactsheetCurrent');
    if (cur) cur.innerHTML = '<span style="font-size:0.82rem;color:var(--text-muted)">No factsheet loaded yet.</span>';
    renderProductsGrid();
    Toast.success('Factsheet removed');
  } catch (e) {
    Toast.error('Failed to remove factsheet: ' + (e.message || 'error'));
  }
}

function openProductModal() {
  document.getElementById('productModalTitle').textContent = 'New Product';
  ['productId','prodType','prodLabel','prodHeadline','prodDescription','prodKeyDetails','prodMin','prodTerm','prodSort','prodBenchmark','prodPerfFee','prodPartner','prodSector','prodRisk','prodIcon','prodColor','prodRiskColor'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('prodActive').value = 'true';
  document.getElementById('prodHomepage').value = 'true';
  document.getElementById('prodRisk').value = 'Medium';   // default risk profile for new products
  document.getElementById('prodType').removeAttribute('readonly');
  const ff = document.getElementById('prodFactsheetFile'); if (ff) ff.value = '';
  document.getElementById('prodFactsheetCurrent').textContent = '';
  document.getElementById('prodAvgReturnInfo').textContent = 'Will calculate once pools of this product mature.';
  const pick = document.getElementById('prodColorPicker'); if (pick) pick.value = '#656565';
  _renderProdColorSwatches();
  Modal.open('productModal');
}

function editProduct(id) {
  const p = (STATE.products || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('productModalTitle').textContent = 'Edit Product';
  document.getElementById('productId').value      = p.id;
  document.getElementById('prodType').value        = p.product_type || '';
  document.getElementById('prodType').setAttribute('readonly', 'readonly'); // key drives existing pools
  document.getElementById('prodLabel').value       = p.label || '';
  document.getElementById('prodHeadline').value    = p.headline || '';
  document.getElementById('prodDescription').value = p.description || '';
  document.getElementById('prodKeyDetails').value  = p.key_details || '';
  document.getElementById('prodMin').value         = p.min_investment || '';
  document.getElementById('prodTerm').value        = p.term_months || '';
  document.getElementById('prodSort').value        = p.sort_order || 0;
  document.getElementById('prodBenchmark').value   = p.benchmark_rate || '';
  document.getElementById('prodPerfFee').value     = p.performance_fee_pct || '';
  document.getElementById('prodPartner').value     = p.partner_name || '';
  document.getElementById('prodSector').value      = p.sector || '';
  document.getElementById('prodRisk').value        = p.risk_profile || '';
  document.getElementById('prodIcon').value        = p.icon || '';
  document.getElementById('prodColor').value       = p.color || '';
  const pick = document.getElementById('prodColorPicker');
  if (pick && /^#[0-9a-fA-F]{6}$/.test(p.color || '')) pick.value = p.color;
  _renderProdColorSwatches();
  document.getElementById('prodRiskColor').value   = p.risk_color || '';
  document.getElementById('prodActive').value      = p.is_active ? 'true' : 'false';
  document.getElementById('prodHomepage').value    = p.display_on_homepage ? 'true' : 'false';
  const ff = document.getElementById('prodFactsheetFile'); if (ff) ff.value = '';
  document.getElementById('prodFactsheetCurrent').innerHTML = p.factsheet_url
    ? `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
         <span style="font-size:0.82rem;color:var(--text-muted)">Current: <strong>${p.factsheet_name || 'factsheet'}</strong> — uploading a new file replaces it.</span>
         <button class="btn btn--danger btn--sm" type="button" onclick="removeProductFactsheet('${p.id}')"><i class="fa-solid fa-trash"></i> Remove</button>
       </div>`
    : '<span style="font-size:0.82rem;color:var(--text-muted)">No factsheet loaded yet.</span>';
  const avg = _productAvgReturn(p.product_type);
  document.getElementById('prodAvgReturnInfo').innerHTML = avg
    ? `<strong style="color:var(--gold)">${(avg.rate * 100).toFixed(2)}% p.a.</strong> — average achieved return across ${avg.count} matured pool${avg.count === 1 ? '' : 's'}. Updates automatically as more pools mature.`
    : 'No matured pools for this product yet — the average return will appear automatically once pools mature.';
  Modal.open('productModal');
}

// ─── Product colour palette editor ───
const PROD_PALETTE = (window.Utils && Utils.ciProductPalette) ||
  ['#fec24f', '#ff5229', '#ffe86a', '#ffb782', '#fec24f', '#eda5ff', '#65ed00', '#0096ff', '#656565', '#303030'];

function _renderProdColorSwatches() {
  const wrap = document.getElementById('prodColorSwatches');
  if (!wrap) return;
  const cur = (document.getElementById('prodColor').value || '').toLowerCase();
  wrap.innerHTML = PROD_PALETTE.map(c => {
    const sel = c.toLowerCase() === cur;
    return `<button type="button" title="${c}" onclick="selectProdColor('${c}')"
      style="width:30px;height:30px;border-radius:8px;background:${c};cursor:pointer;
      border:2px solid ${sel ? '#111' : 'rgba(0,0,0,0.12)'};
      box-shadow:${sel ? '0 0 0 2px #fff, 0 0 0 4px ' + c : 'none'};transition:transform .1s"
      onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'"></button>`;
  }).join('');
}

function selectProdColor(hex) {
  document.getElementById('prodColor').value = hex;
  const pick = document.getElementById('prodColorPicker'); if (pick) pick.value = hex;
  _renderProdColorSwatches();
}
function _onProdColorPick(hex) {
  document.getElementById('prodColor').value = hex;
  _renderProdColorSwatches();
}
function _onProdColorText(hex) {
  const pick = document.getElementById('prodColorPicker');
  if (pick && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) pick.value = hex.trim();
  _renderProdColorSwatches();
}

async function saveProduct(btn) {
  const productType = document.getElementById('prodType').value.trim().toLowerCase().replace(/\s+/g, '_');
  const label = document.getElementById('prodLabel').value.trim();
  if (!productType) { Toast.error('Product key is required'); return; }
  if (!label) { Toast.error('Product name is required'); return; }

  const num = id => { const v = document.getElementById(id).value; return v === '' ? null : (parseFloat(v) || 0); };
  const id = document.getElementById('productId').value;
  const payload = {
    product_type:        productType,
    label,
    headline:            document.getElementById('prodHeadline').value.trim() || null,
    description:         document.getElementById('prodDescription').value.trim() || null,
    key_details:         document.getElementById('prodKeyDetails').value.trim() || null,
    min_investment:      num('prodMin'),
    term_months:         document.getElementById('prodTerm').value ? parseInt(document.getElementById('prodTerm').value) : null,
    benchmark_rate:      num('prodBenchmark'),
    performance_fee_pct: num('prodPerfFee'),
    partner_name:        document.getElementById('prodPartner').value.trim() || null,
    sector:              document.getElementById('prodSector').value || null,
    risk_profile:        document.getElementById('prodRisk').value.trim() || null,
    icon:                document.getElementById('prodIcon').value.trim() || null,
    color:               document.getElementById('prodColor').value.trim() || null,
    risk_color:          document.getElementById('prodRiskColor').value.trim() || null,
    is_active:           document.getElementById('prodActive').value === 'true',
    display_on_homepage: document.getElementById('prodHomepage').value === 'true',
    sort_order:          document.getElementById('prodSort').value ? parseInt(document.getElementById('prodSort').value) : 0,
  };

  await _withBtn(btn, async () => {
    try {
      // Read factsheet file (if a new one was chosen) into a base64 data URL
      const file = document.getElementById('prodFactsheetFile')?.files?.[0];
      if (file) {
        payload.factsheet_url = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = e => resolve(e.target.result);
          r.onerror = () => reject(new Error('Could not read file'));
          r.readAsDataURL(file);
        });
        payload.factsheet_name = file.name;
      }

      if (id) {
        await API.products.update(id, payload);
        Toast.success('Product updated');
      } else {
        // New products get a unique CI-palette colour (white excluded). If the
        // admin didn't pick one, assign the first colour not already in use.
        if (!payload.color) {
          const palette = (window.Utils && Utils.ciProductPalette) ||
            ['#fec24f', '#ff5229', '#ffe86a', '#ffb782', '#fec24f', '#eda5ff', '#65ed00', '#0096ff', '#656565', '#303030'];
          let used = new Set();
          try {
            const existing = (await API.products.list({ limit: 500 })).data || [];
            used = new Set(existing.map(p => String(p.color || '').toLowerCase()));
          } catch (_) {}
          payload.color = palette.find(c => !used.has(c.toLowerCase())) || palette[Math.floor(Math.random() * palette.length)];
        }
        payload.id = `PROD-${productType.toUpperCase()}-${Date.now()}`;
        await API.products.create(payload);
        Toast.success(`Product created — colour ${payload.color}`);
      }
      Modal.close('productModal');
      await loadProducts();
      // Refresh pool product-type dropdowns so the new product is selectable
      _populateProductTypeDropdowns();
    } catch (e) {
      Toast.error('Failed to save product: ' + (e.message || 'unknown error'));
      console.error('[saveProduct]', e);
    }
  });
}

async function deleteProduct(id) {
  const p = (STATE.products || []).find(x => x.id === id);
  const name = p?.label || id;
  if (!await Confirm.ask(`Delete product "${name}"?`, { body: 'Existing pools keep their product type, but it will no longer be selectable or shown on the home page.', confirmLabel: 'Delete', danger: true })) return;
  try {
    await API.products.delete(id);
    Toast.success(`Product "${name}" deleted`);
    await loadProducts();
    _populateProductTypeDropdowns();
  } catch (e) { Toast.error(e.message || 'Failed to delete product'); }
}

// Populate the New/Edit Pool product-type <select>s from the products catalogue
function _populateProductTypeDropdowns() {
  const products = (STATE.products || []).filter(p => p.is_active);
  if (!products.length) return;
  const opts = products.map(p => `<option value="${p.product_type}">${p.label}</option>`).join('');
  ['newPoolType', 'editPoolType'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = opts;
    if (current && products.some(p => p.product_type === current)) sel.value = current;
  });
}

let poolFilter = 'all';

async function loadPools() {
  try {
    const res = await API.pools.list({ limit: 1000 });
    STATE.pools = res.data || [];
    _refreshPoolProductFilter();
    renderPoolsGrid();
    // Load investments in the background if not already loaded (needed for maturing alert)
    if (!STATE.investments || !STATE.investments.length) {
      API.investments.list({ limit: 5000 }).then(r => {
        STATE.investments = r.data || [];
        renderMaturingPoolsAlert();
      }).catch(() => {});
    }
    // Load products in the background so pool product-type dropdowns reflect them
    if (!STATE.products || !STATE.products.length) {
      API.products.list({ limit: 200 }).then(r => {
        STATE.products = (r.data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      }).catch(() => {});
    }
  } catch (e) { Toast.error('Failed to load pools'); }
}

function filterPools(status, btn) {
  poolFilter = status;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPoolsGrid();
}

function _refreshPoolProductFilter() {
  const sel = document.getElementById('poolProductFilter');
  if (!sel) return;
  const types = [...new Set((STATE.pools || []).map(p => (p.product_type === 'smme' ? 'short_term' : p.product_type)).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">All Products</option>' +
    types.map(t => {
      const label = Utils.productInfo(t)?.label || t;
      return `<option value="${_esc(t)}"${t === current ? ' selected' : ''}>${_esc(label)}</option>`;
    }).join('');
}

function renderMaturingPoolsAlert() {
  const el = document.getElementById('poolsMaturingSoon');
  if (!el) return;
  const now   = new Date();
  const in90  = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const maturing = (STATE.pools || [])
    .filter(p => {
      if (['matured', 'closed', 'cancelled'].includes(p.status)) return false;
      const d = new Date(p.maturity_date || p.end_date || '');
      return !isNaN(d) && d >= now && d <= in90;
    })
    .sort((a, b) => new Date(a.maturity_date || a.end_date) - new Date(b.maturity_date || b.end_date));
  if (!maturing.length) { el.innerHTML = ''; return; }
  const allInvts = STATE.investments || [];
  const rows = maturing.map(p => {
    const matDate = new Date(p.maturity_date || p.end_date);
    const days    = Math.max(0, Math.ceil((matDate - now) / (1000 * 60 * 60 * 24)));
    const urgency = days <= 30 ? '#ef4444' : days <= 60 ? '#f97316' : '#fec24f';
    const pi = Utils.productInfo(p.product_type);
    const poolInvts      = allInvts.filter(i => i.pool_id === p.id && i.status === 'active');
    const projReturn     = poolInvts.reduce((s, i) => s + (parseFloat(i.expected_return) || 0), 0);
    const instrTotal     = poolInvts.length;
    const instrSubmitted = poolInvts.filter(i => i.maturity_instruction && i.maturity_instruction !== 'pending').length;
    const instrPct       = instrTotal ? Math.round((instrSubmitted / instrTotal) * 100) : 0;
    const instrColor     = instrPct >= 80 ? '#22c55e' : instrPct >= 50 ? '#fec24f' : '#ef4444';
    return `<tr style="cursor:pointer" onclick='viewPoolInvestors(${JSON.stringify(p.id)})'>
      <td><span class="fw-700">${_esc(p.name)}</span>${p.partner_name ? `<br><span style="font-size:0.7rem;color:var(--text-muted)">${_esc(p.partner_name)}</span>` : ''}</td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td>${Utils.statusBadge(p.status)}</td>
      <td style="font-variant-numeric:tabular-nums">${Utils.date(p.maturity_date || p.end_date)}</td>
      <td><span style="font-weight:700;color:${urgency}">${days} day${days !== 1 ? 's' : ''}</span></td>
      <td>${p.live_investor_count ?? p.investor_count ?? 0}</td>
      <td style="font-variant-numeric:tabular-nums">${Utils.rand(p.live_raised ?? p.raised_amount ?? 0)}</td>
      <td style="font-variant-numeric:tabular-nums;color:#22c55e">${projReturn > 0 ? Utils.rand(projReturn) : '—'}</td>
      <td>
        <span style="font-weight:700;color:${instrColor}">${instrPct}%</span>
        <span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px">${instrSubmitted}/${instrTotal}</span>
      </td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <div style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.28);border-radius:12px;padding:16px 18px;margin:14px 0 10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <i class="fa-solid fa-hourglass-half" style="color:#ef4444;font-size:1rem"></i>
        <span style="font-weight:700;color:var(--text);font-size:0.9rem">Maturing within 90 days</span>
        <span style="background:rgba(239,68,68,0.18);color:#ef4444;border-radius:20px;padding:2px 10px;font-size:0.73rem;font-weight:700">${maturing.length} pool${maturing.length !== 1 ? 's' : ''}</span>
      </div>
      <div style="overflow-x:auto">
        <table class="data-table" style="width:100%">
          <thead><tr>
            <th>Pool</th><th>Type</th><th>Status</th><th>Maturity Date</th><th>Days Left</th><th>Investors</th><th>Raised</th><th>Proj. Return</th><th>Instructions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderPoolsGrid() {
  renderMaturingPoolsAlert();
  const grid = document.getElementById('poolsGrid');
  let pools = poolFilter === 'all'
    ? STATE.pools
    : STATE.pools.filter(p => p.status === poolFilter || (poolFilter === 'active' && p.status === 'filling'));

  // Product type filter
  const productFilter = (document.getElementById('poolProductFilter')?.value || '').trim();
  if (productFilter) {
    pools = pools.filter(p => (p.product_type === 'smme' ? 'short_term' : p.product_type) === productFilter);
  }

  // Free-text search across pool name, product and ID
  const q = (document.getElementById('poolSearch')?.value || '').trim().toLowerCase();
  if (q) {
    pools = pools.filter(p => {
      const label = (Utils.productInfo(p.product_type)?.label || '');
      return [p.name, p.pool_name, p.product_type, label, p.id, p.partner_name]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }

  // Sort by maturity date
  const sort = document.getElementById('poolSort')?.value || '';
  if (sort === 'maturity_asc' || sort === 'maturity_desc') {
    const dir = sort === 'maturity_asc' ? 1 : -1;
    pools = [...pools].sort((a, b) => {
      const da = a.maturity_date || a.end_date || '9999-12-31';
      const db = b.maturity_date || b.end_date || '9999-12-31';
      return da < db ? -dir : da > db ? dir : 0;
    });
  }

  // live_investor_count and live_raised are computed server-side in the pools query via SQL aggregation.
  // No client-side override needed — doing so with STATE.investments causes stale/mismatched zeros.

  if (!pools.length) { grid.innerHTML = '<div class="text-center text-muted" style="grid-column:1/-1;padding:32px">No pools found</div>'; return; }

  grid.innerHTML = pools.map(p => {
    const pi = Utils.productInfo(p.product_type === 'smme' ? 'short_term' : p.product_type);
    const pct = Utils.poolFillPct(p);
    const isWaitlist = p.status === 'waitlist';
    const isFull = (Number(p.max_capacity) > 0) && (Number(p.current_invested) >= Number(p.max_capacity));
    const waitlistCountHtml = (isWaitlist || isFull)
      ? `<div id="wl-count-${p.id}" style="font-size:0.72rem;color:#fec24f;margin-top:4px"><i class="fa-solid fa-spinner fa-spin"></i> Loading waitlist…</div>`
      : '';

    // Manage dropdown for waitlist/reopen
    const canSetWaitlist = ['open', 'filling', 'active'].includes(p.status);
    const pid = p.id; // alias for readability inside template
    const manageDropdown = `
      <div style="position:relative;display:inline-block;z-index:10" class="pool-manage-wrap">
        <button class="btn btn--secondary btn--sm" onclick="togglePoolManageMenu(event,'pool-menu-${pid}')">
          <i class="fa-solid fa-ellipsis-vertical"></i> Manage
        </button>
        <div id="pool-menu-${pid}" style="display:none;position:absolute;top:100%;right:0;margin-top:4px;background:var(--dark-3);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);z-index:9999;min-width:180px;overflow:hidden">
          ${canSetWaitlist ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="setPoolWaitlist('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-clock" style="color:#fec24f;width:16px"></i> Set to Waitlist</button>` : ''}
          ${isWaitlist ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="reopenPool('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-door-open" style="color:#22c55e;width:16px"></i> Reopen Pool</button>` : ''}
          <button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="editPool('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-pen" style="width:16px"></i> Edit Pool</button>
          ${p.status === 'open' ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="closePool('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-lock" style="color:#ef4444;width:16px"></i> Close Pool</button>` : ''}
          ${p.status === 'matured' ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="openPoolCloseoutWizard('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-circle-check" style="color:#22c55e;width:16px"></i> Close-out Wizard</button>` : ''}
          <div style="height:1px;background:var(--border);margin:4px 0"></div>
          <button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem;color:#ef4444" onclick="deletePool('${pid}');document.getElementById('pool-menu-${pid}').style.display='none'"><i class="fa-solid fa-trash" style="width:16px"></i> Delete Pool</button>
        </div>
      </div>`;

    return `
      <div class="pool-card">
        <div class="pool-card__header">
          <div>
            <div class="pool-card__name">${p.name}</div>
            <div class="pool-card__partner">${p.partner_name}</div>
          </div>
          <div class="flex-center gap-8">
            <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
            ${Utils.statusBadge(p.status)}
          </div>
        </div>

        <div class="pool-card__stats">
          <div class="pool-stat"><span class="pool-stat__label">${p.actual_rate > 0 ? 'Achieved' : 'Rate'}</span><span class="pool-stat__value pool-stat__value--gold">${Utils.pct(p.actual_rate > 0 ? p.actual_rate : p.annual_rate)}</span></div>
          <div class="pool-stat" style="cursor:pointer" onclick='viewPoolInvestors(${JSON.stringify(p.id)})' title="Click to view investors">
            <span class="pool-stat__label">Investors</span>
            <span class="pool-stat__value" style="color:var(--gold);text-decoration:underline dotted">${p.live_investor_count ?? p.investor_count ?? 0}</span>
          </div>
          <div class="pool-stat"><span class="pool-stat__label">Term</span><span class="pool-stat__value">${p.term_months ?? '—'}mo</span></div>
          ${p.management_fee_pct > 0 ? `<div class="pool-stat"><span class="pool-stat__label">Mgt Fee</span><span class="pool-stat__value" style="color:#fec24f">${(Number(p.management_fee_pct) * 100).toFixed(2)}% (${p.management_fee_frequency || 'once'})</span></div>` : ''}
        </div>

        ${(() => {
          const fillClass = p.product_type.includes('solar') ? ' progress-fill--green' : p.product_type === 'short_term' ? ' progress-fill--blue' : '';
          if (Utils.poolIsDateTarget(p)) {
            // Date-targeted pools have no funding goal — show days to closure, no bar.
            const days  = Utils.daysRemaining(p.end_date);
            const left  = days === null ? '—'
              : days === 0 ? (p.status === 'open' || p.status === 'waitlist' ? 'Closing today' : 'Closed')
              : `${days} day${days === 1 ? '' : 's'} to closure`;
            return `
              <div class="pool-card__progress-label">
                <span><i class="fa-solid fa-clock" style="margin-right:4px"></i>${left}</span>
              </div>`;
          }
          return `
            <div class="pool-card__progress-label">
              <span>${Utils.rand(p.live_raised ?? p.raised_amount ?? 0)} raised</span>
              <span>${pct}% funded</span>
            </div>
            <div class="progress-bar"><div class="progress-fill${fillClass}" style="width:${pct}%"></div></div>`;
        })()}

        <div style="margin-top:10px">${_capacityBar(p)}</div>
        ${waitlistCountHtml}

        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 12px">
          <span>Opens: ${Utils.date(p.start_date)}</span>
          <span>Closes: ${Utils.date(p.end_date)}</span>
          ${p.investment_start_date || p.end_date ? `<span>Inv. Starts: ${Utils.date(p.investment_start_date || (() => { const d = new Date(p.end_date); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })())}</span>` : ''}
          ${p.maturity_date ? `<span>Matures: ${Utils.date(p.maturity_date)}</span>` : ''}
        </div>

        ${(() => {
          if (p.status !== 'matured' || !p.maturity_summary) return '';
          const sm = typeof p.maturity_summary === 'string' ? JSON.parse(p.maturity_summary) : p.maturity_summary;
          const labelMap = {
            reinvest:       'Reinvest',
            auto_reinvest:  'Automatic Reinvest',
            payout_all:     'Payout',
            payout_return:  'Payout Return',
            payout_custom:  'Payout Custom',
            switch_product: 'Switch Product',
            custom_switch:  'Custom Switch',
          };
          const rows = Object.entries(sm).map(([k, v]) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0">
               <span style="color:var(--text-muted)">${labelMap[k] || k} <span style="color:var(--text-dim);font-size:0.68rem">(${v.count})</span></span>
               <span style="font-weight:600;font-variant-numeric:tabular-nums">${Utils.rand(v.total)}</span>
             </div>`
          ).join('');
          return `<div style="margin-top:10px;padding:10px 12px;background:var(--dark-2);border-radius:8px;border:1px solid var(--border);font-size:0.75rem">
            <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim);margin-bottom:6px"><i class="fa-solid fa-list-check" style="margin-right:4px;color:#22c55e"></i>Maturity Instructions Executed</div>
            ${rows}
          </div>`;
        })()}

        <div class="pool-card__actions">
          <button class="btn btn--secondary btn--sm flex-1" onclick='editPool(${JSON.stringify(p.id)})'><i class="fa-solid fa-pen"></i> Edit</button>
          <button class="btn btn--secondary btn--sm" onclick='openFactsheetManager(${JSON.stringify(p.id)},${JSON.stringify(p.name)})' title="Manage factsheets"><i class="fa-solid fa-file-pdf" style="color:#ef4444"></i></button>
          <button class="btn btn--secondary btn--sm" onclick='openMergePoolModal(${JSON.stringify(p.id)})' title="Merge into another pool"><i class="fa-solid fa-code-merge"></i> Merge</button>
          <button class="btn btn--danger btn--sm" onclick='deletePool(${JSON.stringify(p.id)})'><i class="fa-solid fa-trash"></i></button>
          ${manageDropdown}
        </div>
      </div>
    `;
  }).join('');

  // Async-load waitlist counts for pools that need them
  pools.forEach(p => {
    const isWaitlist = p.status === 'waitlist';
    const isFull = (Number(p.max_capacity) > 0) && (Number(p.current_invested) >= Number(p.max_capacity));
    if (isWaitlist || isFull) _loadWaitlistCount(p.id);
  });
}

let _currentPoolId = null;
let _poolInvestorsSnapshot = null; // cached for CSV export

async function viewPoolInvestors(poolId) {
  _currentPoolId = poolId;
  const pool = STATE.pools.find(p => p.id === poolId);
  if (!pool) return;

  const modal = document.getElementById('poolInvestorsModal');
  const title = document.getElementById('poolInvestorsTitle');
  const body  = document.getElementById('poolInvestorsBody');

  title.textContent = pool.name;
  body.innerHTML = '<div class="text-center text-muted" style="padding:32px"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  Modal.open('poolInvestorsModal');

  try {
    const token = localStorage.getItem('svc_token');
    const res   = await fetch(`/api/tables/investment_pools/${encodeURIComponent(poolId)}/investors`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to load');
    const { investors, summary } = await res.json();
    _poolInvestorsSnapshot = { investors, summary, poolName: pool.name };

    const statusColor = { active:'badge--green', matured:'badge--purple', paid_out:'badge--blue', cancelled:'badge--red' };

    const hasFees = summary.mgmt_fee_pct > 0;

    body.innerHTML = `
      <!-- Pool stats -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px">
        ${[
          ['Total Raised',  Utils.rand(summary.total_invested), 'coins',         '#fec24f'],
          ['Investors',     summary.investor_count,             'users',          '#656565'],
          ['Active',        summary.active_count,               'chart-line',     '#22c55e'],
          ['Matured',       summary.matured_count,              'flag-checkered', '#eda5ff'],
          ['Cancelled',     summary.cancelled_count,            'ban',            '#ef4444'],
        ].map(([label, val, icon, color]) => `
          <div style="background:var(--bg-secondary);border-radius:10px;padding:14px;text-align:center">
            <i class="fa-solid fa-${icon}" style="color:${color};font-size:1.1rem;display:block;margin-bottom:6px"></i>
            <div style="font-size:1.25rem;font-weight:800;color:var(--text)">${val}</div>
            <div style="font-size:0.72rem;color:var(--text-muted)">${label}</div>
          </div>`).join('')}
      </div>

      <!-- Fee summary bar -->
      ${investors.length ? `
      <div style="background:var(--bg-secondary);border-radius:10px;padding:14px 18px;margin-bottom:16px;display:grid;grid-template-columns:repeat(5,1fr);gap:12px;border:1px solid var(--border)">
        <div>
          <div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">Gross Invested</div>
          <div style="font-size:0.95rem;font-weight:800;color:var(--gold)">${Utils.rand(summary.total_invested)}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">Upfront Fee${hasFees ? ` (${(summary.mgmt_fee_pct*100).toFixed(2)}%)` : ''}</div>
          <div style="font-size:0.95rem;font-weight:800;color:#f97316">${hasFees ? Utils.rand(summary.total_upfront_fees) : '—'}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">Platform Fee (1%)</div>
          <div style="font-size:0.95rem;font-weight:800;color:#f97316">${Utils.rand(summary.total_platform_fees)}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">EVA (from Upfront)</div>
          <div style="font-size:0.95rem;font-weight:800;color:#eda5ff">${hasFees ? Utils.rand(summary.total_eva) : '—'}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:4px">Net Invested</div>
          <div style="font-size:0.95rem;font-weight:800;color:#22c55e">${Utils.rand(summary.total_net_invested)}</div>
        </div>
      </div>

      <!-- Search -->
      <div style="margin-bottom:10px">
        <input type="text" id="poolInvSearch" class="form-input" placeholder="Search by name, email or account…"
          oninput="_filterPoolInvTable(this.value)"
          style="width:100%;max-width:380px;font-size:0.82rem;padding:7px 12px" />
      </div>

      <!-- Per-investment table -->
      <div style="overflow-x:auto">
        <table class="data-table" style="table-layout:fixed;width:100%;min-width:900px">
          <thead><tr>
            <th style="width:16%">Investor</th>
            <th style="width:11%">Account</th>
            <th style="width:9%">Gross Amt</th>
            <th style="width:8%">Upfront Fee</th>
            <th style="width:8%">Platform Fee</th>
            <th style="width:8%">EVA</th>
            <th style="width:9%">Net Amount</th>
            <th style="width:7%">Rate</th>
            <th style="width:8%">Status</th>
            <th style="width:8%">Start</th>
            <th style="width:10%">Source</th>
          </tr></thead>
          <tbody>
            ${investors.map(r => {
              const name = `${r.first_name||''} ${r.last_name||''}`.trim() || r.investor_id;
              const acctCell = r.sub_account_id
                ? `<div style="font-size:0.72rem;font-weight:700;color:#eda5ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${r.sub_account_id}">${r.sub_account_name||'Sub Account'}</div><div style="font-size:0.62rem;color:var(--text-muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.sub_account_type||''}</div>`
                : `<span style="font-family:monospace;font-size:0.75rem;color:var(--gold)">${r.investor_id}</span>`;
              const isCancelled = r.investment_status === 'cancelled';
              return `<tr style="cursor:pointer;${isCancelled ? 'opacity:0.5;' : ''}" onclick="viewInvestor('${r.investor_id}');Modal.close('poolInvestorsModal')">
                <td><div class="td-strong clip">${name}</div><div class="td-muted clip" style="font-size:0.7rem">${r.email||''}</div></td>
                <td class="clip">${acctCell}</td>
                <td class="td-gold fw-700 clip">${Utils.rand(r.amount)}</td>
                <td class="clip" style="font-size:0.78rem;color:#f97316">${r.upfront_fee > 0 ? Utils.rand(r.upfront_fee) : '—'}</td>
                <td class="clip" style="font-size:0.78rem;color:#f97316">${Utils.rand(r.platform_fee)}</td>
                <td class="clip" style="font-size:0.78rem;color:#eda5ff">${r.eva_contribution > 0 ? Utils.rand(r.eva_contribution) : '—'}</td>
                <td class="clip" style="font-size:0.82rem;font-weight:700;color:#22c55e">${Utils.rand(r.net_amount)}</td>
                <td class="td-green clip">${r.annual_rate ? Utils.pct(r.annual_rate) : '—'}</td>
                <td><span class="badge ${statusColor[r.investment_status]||'badge--gray'}">${r.investment_status||'—'}</span></td>
                <td class="td-muted clip">${Utils.date(r.start_date)}</td>
                <td class="clip">
                  ${r.is_reinvestment
                    ? '<span class="badge badge--purple" style="font-size:0.65rem">Reinvestment</span>'
                    : '<span class="badge badge--blue"   style="font-size:0.65rem">New</span>'}
                  <div style="font-size:0.65rem;color:var(--text-muted);margin-top:3px">${r.maturity_instruction?.replace(/_/g,' ')||'—'}</div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : '<div class="text-center text-muted" style="padding:32px">No investments in this pool yet</div>'}
    `;
  } catch (e) {
    body.innerHTML = `<div class="text-center text-muted" style="padding:32px">Failed to load pool investors</div>`;
  }
}

function _filterPoolInvTable(q) {
  const needle = (q || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#poolInvestorsBody .data-table tbody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = (!needle || text.includes(needle)) ? '' : 'none';
  });
}

function downloadPoolCsv() {
  if (!_poolInvestorsSnapshot || !_poolInvestorsSnapshot.investors.length) {
    Toast.error('No data to export');
    return;
  }
  const { investors, poolName } = _poolInvestorsSnapshot;
  const PLATFORM_FEE_PCT = 0.01;

  const headers = ['Investor','Email','Account ID','Sub Account','Gross Amount','Upfront Fee','Platform Fee','EVA','Net Amount','Annual Rate','Status','Start Date','Maturity Date','Maturity Instruction','Source'];

  const csvRows = [headers];
  for (const r of investors) {
    const name = `${r.first_name||''} ${r.last_name||''}`.trim();
    const acct = r.sub_account_id ? (r.sub_account_name||r.sub_account_id) : r.investor_id;
    const amt  = parseFloat(r.amount) || 0;
    const platformFee = Math.round(amt * PLATFORM_FEE_PCT * 100) / 100;
    csvRows.push([
      name,
      r.email || '',
      r.sub_account_id ? r.sub_account_id : r.investor_id,
      r.sub_account_id ? acct : '',
      amt.toFixed(2),
      (r.upfront_fee || 0).toFixed(2),
      platformFee.toFixed(2),
      (r.eva_contribution || 0).toFixed(2),
      (r.net_amount || 0).toFixed(2),
      r.annual_rate ? (parseFloat(r.annual_rate) * 100).toFixed(2) + '%' : '0.00%',
      r.investment_status || '',
      r.start_date ? r.start_date.slice(0, 10) : '',
      r.end_date   ? r.end_date.slice(0, 10)   : '',
      (r.maturity_instruction || '').replace(/_/g, ' '),
      r.is_reinvestment ? 'Reinvestment' : 'New',
    ]);
  }

  const csv = csvRows.map(row =>
    row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(poolName||'pool').replace(/[^a-z0-9]+/gi,'-')}-investments.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function togglePoolManageMenu(evt, menuId) {
  evt.stopPropagation();
  document.querySelectorAll('[id^="pool-menu-"]').forEach(m => { if (m.id !== menuId) m.style.display = 'none'; });
  const menu = document.getElementById(menuId);
  if (!menu) return;
  const isHidden = menu.style.display === 'none' || !menu.style.display;
  menu.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    setTimeout(() => {
      document.addEventListener('click', function closeMenu(e) {
        if (!menu.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 200);
  }
}

async function _loadWaitlistCount(poolId) {
  const el = document.getElementById(`wl-count-${poolId}`);
  if (!el) return;
  try {
    const res = await fetch(`/api/tables/investment_waitlist?pool_id=${encodeURIComponent(poolId)}`, {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('svc_token') }
    });
    if (res.ok) {
      const data = await res.json();
      const count = (data.data || []).length || data.count || 0;
      el.innerHTML = count
        ? `<i class="fa-solid fa-hourglass-half" style="color:#fec24f"></i> ${count} investor${count !== 1 ? 's' : ''} waiting`
        : '<i class="fa-solid fa-check" style="color:#22c55e"></i> No waitlist entries';
    } else {
      el.textContent = '';
    }
  } catch (_) { el.textContent = ''; }
}

async function setPoolWaitlist(id) {
  if (!await Confirm.ask('Set pool to Waitlist?', { body: 'New investments will be paused. Investors can join a waitlist.', confirmLabel: 'Set Waitlist' })) return;
  try {
    await API.pools.update(id, { status: 'waitlist' });
    Toast.success('Pool set to Waitlist');
    await loadPools();
  } catch (e) { Toast.error('Failed to update pool status'); }
}

/* ── Factsheet Manager ─────────────────────────────── */
async function openFactsheetManager(poolId, poolName) {
  const modal = document.getElementById('adminFactsheetModal');
  const title = document.getElementById('adminFsTitle');
  const list  = document.getElementById('adminFsList');
  if (!modal) return;
  if (title) title.textContent = `${poolName} — Factsheets`;
  modal.dataset.poolId   = poolId;
  modal.dataset.poolName = poolName;
  // Reset file input
  const inp = document.getElementById('adminFsFileInput');
  if (inp) inp.value = '';
  const namEl = document.getElementById('adminFsFileName');
  if (namEl) namEl.value = '';
  const verEl = document.getElementById('adminFsVersion');
  if (verEl) verEl.value = '';
  Modal.open('adminFactsheetModal');
  await _loadAdminFactsheets(poolId, list);
}

async function _loadAdminFactsheets(poolId, listEl) {
  if (!listEl) return;
  listEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;text-align:center;padding:20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  try {
    const res = await API._fetch('GET', `factsheets?pool_id=${poolId}`);
    const sheets = res.data || [];
    if (!sheets.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:0.78rem;text-align:center;padding:16px">No factsheets yet — upload one above.</div>';
      return;
    }
    listEl.innerHTML = sheets.map(s => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--dark-3);border-radius:10px;border:1px solid var(--border)">
        <i class="fa-solid fa-file-pdf" style="color:#ef4444;font-size:1.1rem;flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.82rem;font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${_esc(s.file_name)}
            ${s.is_current ? '<span style="font-size:0.6rem;background:rgba(34,197,94,0.15);color:#22c55e;padding:1px 6px;border-radius:99px;font-weight:800">CURRENT</span>' : ''}
          </div>
          <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">${s.version ? `v${_esc(s.version)} · ` : ''}${Utils.date(s.created_at)}${s.uploaded_by ? ` · ${_esc(s.uploaded_by)}` : ''}</div>
        </div>
        <a href="${s.file_url}" target="_blank" rel="noopener" class="btn btn--ghost btn--sm" title="Open"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
        <button class="btn btn--ghost btn--sm" style="color:#ef4444" onclick="deleteFactsheet('${s.id}','${poolId}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:#ef4444;font-size:0.78rem;text-align:center;padding:12px">${e.message}</div>`;
  }
}

async function uploadFactsheet() {
  const modal   = document.getElementById('adminFactsheetModal');
  const poolId  = modal?.dataset.poolId;
  const poolName= modal?.dataset.poolName;
  const fileInput = document.getElementById('adminFsFileInput');
  const nameEl  = document.getElementById('adminFsFileName');
  const verEl   = document.getElementById('adminFsVersion');
  const btn     = document.getElementById('adminFsUploadBtn');

  if (!poolId) return;
  const fileName = nameEl?.value?.trim();
  const version  = verEl?.value?.trim();
  const file     = fileInput?.files?.[0];

  if (!fileName) { Toast.error('Enter a factsheet name'); return; }
  if (!file) { Toast.error('Select a PDF file to upload'); return; }
  if (file.type && file.type !== 'application/pdf') { Toast.error('Only PDF files are allowed'); return; }

  // Read file as base64 data URL and use it directly as the file_url
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…'; }
      const res = await API._fetch('POST', 'factsheets/upload', {
        pool_id:   poolId,
        pool_name: poolName,
        file_name: fileName,
        file_url:  e.target.result,  // base64 data URL stored in DB
        file_size: file.size,
        mime_type: file.type || 'application/pdf',
        version,
      });
      if (res.error) throw new Error(res.error);
      Toast.success('Factsheet uploaded');
      if (nameEl) nameEl.value = '';
      if (verEl)  verEl.value  = '';
      if (fileInput) fileInput.value = '';
      await _loadAdminFactsheets(poolId, document.getElementById('adminFsList'));
    } catch (err) {
      Toast.error('Upload failed: ' + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload'; }
    }
  };
  reader.readAsDataURL(file);
}

async function deleteFactsheet(fsId, poolId) {
  if (!await Confirm.ask('Delete factsheet?', { body: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try {
    await API._fetch('DELETE', `factsheets/${fsId}`);
    Toast.success('Factsheet deleted');
    await _loadAdminFactsheets(poolId, document.getElementById('adminFsList'));
  } catch (e) {
    Toast.error('Delete failed: ' + e.message);
  }
}

async function runPoolCycler(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Running…'; }
  try {
    const res = await fetch('/api/admin/run-pool-cycler', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('svc_token') },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Server error');
    if (data.cycled > 0) {
      Toast.success(`Pool cycler ran — ${data.cycled} pool(s) cycled`);
      await loadPools();
    } else {
      Toast.info('Pool cycler ran — no pools needed cycling');
    }
  } catch (e) {
    Toast.error('Pool cycler failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Run Pool Cycler'; }
  }
}

async function reopenPool(id) {
  if (!await Confirm.ask('Reopen pool?', { body: 'This pool will accept new investments again.', confirmLabel: 'Reopen' })) return;
  try {
    await API.pools.update(id, { status: 'open' });
    Toast.success('Pool reopened');
    // Offer to notify waitlist
    setTimeout(async () => {
      const notify = await Confirm.ask('Notify waitlist investors?', { body: 'An email will be sent to all investors on the waitlist for this pool.', confirmLabel: 'Send Notification' });
      if (notify) await notifyWaitlist(id);
    }, 300);
    await loadPools();
  } catch (e) { Toast.error('Failed to reopen pool'); }
}

async function notifyWaitlist(poolId) {
  try {
    const res = await fetch('/api/tables/investment_waitlist/notify', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + localStorage.getItem('svc_token'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pool_id: poolId })
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      Toast.success(data.message || 'Waitlist notifications sent');
    } else if (res.status === 404) {
      Toast.info('Waitlist notification endpoint not yet configured — no emails sent');
    } else {
      Toast.error('Failed to notify waitlist');
    }
  } catch (_) {
    Toast.success('Notifications sent');
  }
}

async function _ensureProductsForDropdowns() {
  if (!STATE.products || !STATE.products.length) {
    try { const r = await API.products.list({ limit: 200 }); STATE.products = (r.data || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); } catch (_) {}
  }
  _populateProductTypeDropdowns();
}

function openAddPoolModal() { _poolNameManual = false; _syncPoolTargetType('new'); _ensureProductsForDropdowns(); Modal.open('addPoolModal'); }

// Track whether admin has manually typed a pool name
let _poolNameManual = false;
function _syncPoolNameManual() { _poolNameManual = true; }

function _autoPoolName() {
  if (_poolNameManual) return; // don't override manual input
  const typeEl    = document.getElementById('newPoolType');
  const closeEl   = document.getElementById('newPoolCloseDate');
  const partnerEl = document.getElementById('newPoolPartner');
  const nameEl    = document.getElementById('newPoolName');
  if (!typeEl || !nameEl) return;

  const typeLabels = {
    cattle:        'Cattle Investment',
    solar_7yr:     'Solar Investment',
    solar_6yr:     'Solar Investment',
    solar_5yr:     'Solar Investment',
    short_term:    'Short Term Investment',
    delivery_bike: 'Delivery Bikes',
  };
  const productLabel = typeLabels[typeEl.value] || typeEl.value;
  const partner      = partnerEl?.value.trim();
  const closeDate    = closeEl?.value;
  const monthYear    = closeDate
    ? new Date(closeDate).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })
    : '';

  const parts = [productLabel];
  if (monthYear) parts.push(monthYear);
  if (partner)   parts.push(partner);

  nameEl.value = parts.join(' - ');
}

/* Show/hide the Target Amount field depending on the chosen target type.
   'amount' pools raise to a goal R amount; 'date' pools simply stay open
   until their Close Date, so the amount goal is not applicable. */
function _syncPoolTargetType(which) {
  const sel  = document.getElementById(`${which}PoolTargetType`);
  const wrap = document.getElementById(`${which}PoolTargetWrap`);
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'date' ? 'none' : '';
}

function _autoCalcMaturityDate(openDateId, termId, closeDateId) {
  const openVal = document.getElementById(openDateId)?.value;
  const termVal = parseInt(document.getElementById(termId)?.value) || 0;
  const closeEl = document.getElementById(closeDateId);
  if (!closeEl || !openVal || !termVal) return;
  const d = new Date(openVal);
  d.setMonth(d.getMonth() + termVal);
  closeEl.value = d.toISOString().split('T')[0];
}

function _autoCalcInvStartDate(closeDateId, targetId) {
  const closeVal = document.getElementById(closeDateId)?.value;
  const targetEl = document.getElementById(targetId);
  if (!targetEl || !closeVal) return;
  const d = new Date(closeVal);
  d.setDate(d.getDate() + 1);
  targetEl.value = d.toISOString().split('T')[0];
}

async function saveNewPool(btn) {
  const name = document.getElementById('newPoolName').value.trim();
  const type = document.getElementById('newPoolType').value;
  const target = parseFloat(document.getElementById('newPoolTarget').value);
  if (!name) { Toast.error('Pool name is required'); return; }
  const maxCapVal = document.getElementById('newPoolMaxCapacity').value;
  const max_capacity = maxCapVal ? (parseFloat(maxCapVal) || null) : null;
  await _withBtn(btn, async () => {
    try {
      await API.pools.create({
        id: `POOL-${type.toUpperCase().slice(0,3)}-${Date.now()}`,
        name, product_type: type,
        target_type: document.getElementById('newPoolTargetType')?.value || 'amount',
        target_amount: target || 0, raised_amount: 0,
        min_investment: parseFloat(document.getElementById('newPoolMin').value) || 500,
        term_months: parseInt(document.getElementById('newPoolTerm').value) || 12,
        annual_rate: parseFloat(document.getElementById('newPoolRate').value) || 0.13,
        partner_name: document.getElementById('newPoolPartner').value.trim(),
        start_date: document.getElementById('newPoolOpenDate').value || new Date().toISOString().split('T')[0],
        end_date: document.getElementById('newPoolCloseDate').value || null,
        investment_start_date: document.getElementById('newPoolInvStartDate').value || null,
        maturity_date: document.getElementById('newPoolMaturityDate').value || null,
        status: 'open', investor_count: 0,
        max_capacity,
        management_fee_pct:       (parseFloat(document.getElementById('newPoolMgtFeePct')?.value) || 0) / 100,
        management_fee_frequency: document.getElementById('newPoolMgtFeeFreq')?.value || 'once',
        operational_fee_pct:      (parseFloat(document.getElementById('newPoolOpFeePct')?.value) || 0) / 100,
        operational_fee_frequency: document.getElementById('newPoolOpFeeFreq')?.value || 'annual',
      });
      Toast.success('Pool created');
      Modal.close('addPoolModal');
      await loadPools();
    } catch (e) {
      Toast.error('Failed to create pool: ' + (e.message || 'unknown error'));
      console.error('[saveNewPool]', e);
    }
  });
}

async function closePool(id) {
  if (!await Confirm.ask('Close pool?', { body: 'This pool will no longer accept new investments.', confirmLabel: 'Close Pool' })) return;
  try { await API.pools.update(id, { status: 'closed' }); Toast.success('Pool closed'); await loadPools(); }
  catch (e) { Toast.error('Failed to close pool'); }
}

async function markPaidOut(id) {
  openPoolCloseoutWizard(id);
}

function openMergePoolModal(sourceId) {
  const source = STATE.pools.find(p => p.id === sourceId);
  if (!source) return;

  document.getElementById('mergeSourcePoolId').value = sourceId;
  document.getElementById('mergeSourceName').textContent = source.name;

  const sel = document.getElementById('mergeTargetPool');
  sel.innerHTML = '<option value="">— Select target pool —</option>' +
    STATE.pools
      .filter(p => p.id !== sourceId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(p => `<option value="${_esc(p.id)}">${_esc(p.name)} (${p.status})</option>`)
      .join('');
  sel.value = '';
  Modal.open('mergePoolModal');
}

async function confirmMergePool() {
  const sourceId = document.getElementById('mergeSourcePoolId').value;
  const targetId = document.getElementById('mergeTargetPool').value;
  if (!targetId) { Toast.error('Please select a target pool.'); return; }

  const source = STATE.pools.find(p => p.id === sourceId);
  const target = STATE.pools.find(p => p.id === targetId);
  if (!await Confirm.ask(`Merge "${source?.name}" into "${target?.name}"?`, {
    body: 'All investments will be moved to the target pool and the source pool will be deleted. This cannot be undone.',
    confirmLabel: 'Merge & Delete',
    danger: true,
  })) return;

  try {
    const token = localStorage.getItem('svc_token');
    const res = await fetch(`/api/tables/investment_pools/${encodeURIComponent(sourceId)}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_pool_id: targetId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Merge failed');
    Modal.close('mergePoolModal');
    Toast.success(`Merged ${data.merged} investment(s) into "${target?.name}" — source pool deleted.`);
    await loadPools();
  } catch (e) {
    Toast.error('Merge failed: ' + e.message);
  }
}

function openUnmergeModal() {
  const sel = document.getElementById('unmergeTargetPool');
  sel.innerHTML = '<option value="">— Select pool —</option>' +
    (STATE.pools || [])
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(p => `<option value="${_esc(p.id)}">${_esc(p.name)} (${p.status})</option>`)
      .join('');
  document.getElementById('unmergeInvList').style.display = 'none';
  Modal.open('unmergePoolModal');
}

async function loadUnmergeInvestments() {
  const targetId = document.getElementById('unmergeTargetPool').value;
  const listEl   = document.getElementById('unmergeInvList');
  const itemsEl  = document.getElementById('unmergeInvItems');
  const countEl  = document.getElementById('unmergeInvCount');

  if (!targetId) { listEl.style.display = 'none'; return; }

  listEl.style.display = 'block';
  itemsEl.innerHTML = '<p style="padding:10px;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Loading investments…</p>';
  countEl.textContent = '';

  let invs = [];
  try {
    const token = localStorage.getItem('svc_token');
    const r = await fetch(`/api/tables/investment_pools/${encodeURIComponent(targetId)}/all-investments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    invs = d.data || [];
  } catch (e) {
    itemsEl.innerHTML = `<p style="padding:10px;color:#ef4444;font-size:0.85rem">Failed to load: ${_esc(e.message)}</p>`;
    return;
  }

  if (!invs.length) {
    itemsEl.innerHTML = '<p style="padding:10px;color:var(--text-muted);font-size:0.85rem">No investments found in this pool.</p>';
    return;
  }

  itemsEl.innerHTML = invs.map(i => {
    const name = i.investor_name || i.investor_id || '—';
    const amt  = Utils.fmtCcy(i.amount);
    const date = i.start_date ? new Date(i.start_date).toLocaleDateString('en-ZA') : '—';
    return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.83rem">
      <input type="checkbox" class="unmerge-inv-cb" value="${_esc(i.id)}" checked style="width:15px;height:15px;accent-color:#eda5ff">
      <span style="flex:1">${_esc(name)}</span>
      <span style="color:var(--text-muted)">${_esc(i.status || '')}</span>
      <span style="font-variant-numeric:tabular-nums;font-weight:600">${amt}</span>
      <span style="color:var(--text-muted);min-width:80px;text-align:right">${date}</span>
    </label>`;
  }).join('');

  updateUnmergeCount();
  itemsEl.querySelectorAll('.unmerge-inv-cb').forEach(cb => cb.addEventListener('change', updateUnmergeCount));
}

function updateUnmergeCount() {
  const checked = document.querySelectorAll('.unmerge-inv-cb:checked').length;
  const total   = document.querySelectorAll('.unmerge-inv-cb').length;
  document.getElementById('unmergeInvCount').textContent = `${checked} of ${total} investment(s) selected`;
}

function unmergeSelectAll(check) {
  document.querySelectorAll('.unmerge-inv-cb').forEach(cb => { cb.checked = check; });
  updateUnmergeCount();
}

async function confirmUnmerge() {
  const targetId = document.getElementById('unmergeTargetPool').value;
  if (!targetId) { Toast.error('Please select the target pool.'); return; }

  const ids = [...document.querySelectorAll('.unmerge-inv-cb:checked')].map(cb => cb.value);
  if (!ids.length) { Toast.error('Select at least one investment to move back.'); return; }

  const name = (document.getElementById('unmergePoolName').value || '').trim();
  const product = document.getElementById('unmergePoolProduct').value;
  if (!name)    { Toast.error('Pool name is required.'); return; }
  if (!product) { Toast.error('Product type is required.'); return; }

  const poolData = {
    name,
    product_type:        product,
    status:              document.getElementById('unmergePoolStatus').value || 'open',
    annual_rate:         parseFloat(document.getElementById('unmergePoolRate').value) || 0,
    term_months:         parseInt(document.getElementById('unmergePoolTerm').value) || 6,
    min_investment:      parseFloat(document.getElementById('unmergePoolMin').value) || 1000,
    start_date:          document.getElementById('unmergePoolStart').value || null,
    end_date:            document.getElementById('unmergePoolEnd').value || null,
    maturity_date:       document.getElementById('unmergePoolEnd').value || null,
    partner_name:        (document.getElementById('unmergePoolPartner').value || '').trim() || null,
    risk_level:          document.getElementById('unmergePoolRisk').value || 'medium',
    description:         (document.getElementById('unmergePoolDesc').value || '').trim() || null,
  };

  const targetName = (STATE.pools.find(p => p.id === targetId)?.name) || targetId;
  if (!await Confirm.ask(`Restore pool "${name}"?`, {
    body: `${ids.length} investment(s) will be moved from "${targetName}" to the new pool "${name}". This cannot be undone.`,
    confirmLabel: 'Restore Pool',
  })) return;

  try {
    const token = localStorage.getItem('svc_token');
    const res = await fetch('/api/tables/investment_pools/unmerge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ investment_ids: ids, pool: poolData }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unmerge failed');
    Modal.close('unmergePoolModal');
    Toast.success(`Pool "${name}" restored — ${data.moved} investment(s) moved back.`);
    await Promise.all([loadPools(), loadInvestments()]);
  } catch (e) {
    Toast.error('Unmerge failed: ' + e.message);
  }
}

function openMoveInvestmentsModal() {
  const allPools = (STATE.pools || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const opts = '<option value="">— Select pool —</option>' +
    allPools.map(p => `<option value="${_esc(p.id)}">${_esc(p.name)} (${p.status})</option>`).join('');
  document.getElementById('moveInvSource').innerHTML = opts;
  document.getElementById('moveInvTarget').innerHTML = opts;
  document.getElementById('moveInvList').style.display  = 'none';
  document.getElementById('moveInvEmpty').style.display = 'none';
  document.getElementById('moveInvItems').innerHTML = '';
  Modal.open('moveInvestmentsModal');
}

async function loadMoveInvestmentsList() {
  const sourceId = document.getElementById('moveInvSource').value;
  const listEl   = document.getElementById('moveInvList');
  const emptyEl  = document.getElementById('moveInvEmpty');
  const itemsEl  = document.getElementById('moveInvItems');
  const countEl  = document.getElementById('moveInvCount');
  listEl.style.display  = 'none';
  emptyEl.style.display = 'none';
  itemsEl.innerHTML = '';
  countEl.textContent = '';
  if (!sourceId) return;

  listEl.style.display = 'block';
  itemsEl.innerHTML = '<p style="padding:12px;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Loading investments…</p>';

  let invs = [];
  try {
    const token = localStorage.getItem('svc_token');
    const r = await fetch(`/api/tables/investment_pools/${encodeURIComponent(sourceId)}/all-investments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    invs = d.data || [];
  } catch (e) {
    itemsEl.innerHTML = `<p style="padding:12px;color:#ef4444;font-size:0.85rem">Failed to load investments: ${_esc(e.message)}</p>`;
    return;
  }

  if (!invs.length) {
    listEl.style.display  = 'none';
    emptyEl.style.display = 'block';
    return;
  }

  itemsEl.innerHTML = invs.map(i => {
    const name  = i.investor_name || i.investor_id || '—';
    const saId  = i.sub_account_id || '—';
    const amt   = Utils.fmtCcy(i.amount);
    const edate = i.end_date ? new Date(i.end_date).toLocaleDateString('en-ZA') : '—';
    const rate  = i.annual_rate ? `${Number(i.annual_rate).toFixed(2)}%` : '0%';
    return `<label style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.82rem">
      <input type="checkbox" class="move-inv-cb" value="${_esc(i.id)}" checked style="width:15px;height:15px;accent-color:#eda5ff;flex-shrink:0">
      <span style="min-width:120px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(name)}">${_esc(name)}</span>
      <span style="color:var(--text-muted);min-width:90px;font-size:0.78rem">${_esc(saId)}</span>
      <span style="color:var(--text-muted);font-size:0.78rem">${rate}</span>
      <span style="font-variant-numeric:tabular-nums;font-weight:600;min-width:90px;text-align:right">${amt}</span>
      <span style="color:var(--text-muted);font-size:0.78rem;min-width:75px;text-align:right">${edate}</span>
    </label>`;
  }).join('');

  updateMoveInvCount();
  itemsEl.querySelectorAll('.move-inv-cb').forEach(cb => cb.addEventListener('change', updateMoveInvCount));
}

function updateMoveInvCount() {
  const checked = document.querySelectorAll('.move-inv-cb:checked').length;
  const total   = document.querySelectorAll('.move-inv-cb').length;
  document.getElementById('moveInvCount').textContent = `${checked} of ${total} investment(s) selected`;
}

function moveInvSelectAll(check) {
  document.querySelectorAll('.move-inv-cb').forEach(cb => { cb.checked = check; });
  updateMoveInvCount();
}

async function confirmMoveInvestments() {
  const sourceId = document.getElementById('moveInvSource').value;
  const targetId = document.getElementById('moveInvTarget').value;
  if (!sourceId) { Toast.error('Select a source pool.'); return; }
  if (!targetId) { Toast.error('Select a target pool.'); return; }
  if (sourceId === targetId) { Toast.error('Source and target pools must differ.'); return; }

  const ids = [...document.querySelectorAll('.move-inv-cb:checked')].map(cb => cb.value);
  if (!ids.length) { Toast.error('Select at least one investment to move.'); return; }

  const srcName = STATE.pools.find(p => p.id === sourceId)?.name || sourceId;
  const tgtName = STATE.pools.find(p => p.id === targetId)?.name || targetId;

  if (!await Confirm.ask(`Move ${ids.length} investment(s)?`, {
    body: `Investments will be moved from "${srcName}" to "${tgtName}". This cannot be undone.`,
    confirmLabel: 'Move Investments',
    danger: true,
  })) return;

  try {
    const token = localStorage.getItem('svc_token');
    const res = await fetch('/api/admin/bulk-reassign-investments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ source_pool_id: sourceId, target_pool_id: targetId, investment_ids: ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Move failed');
    Modal.close('moveInvestmentsModal');
    Toast.success(`Moved ${data.moved} investment(s) from "${srcName}" to "${tgtName}".`);
    await Promise.all([loadPools(), loadInvestments()]);
  } catch (e) {
    Toast.error('Move failed: ' + e.message);
  }
}

async function deletePool(id) {
  const pool = STATE.pools.find(p => p.id === id);
  const name = pool?.name || id;

  // Check for linked investments before confirming
  const activeInvestments = (STATE.investments || []).filter(i => i.pool_id === id && i.status === 'active');
  const warningLine = activeInvestments.length > 0
    ? `\n\n⚠️  WARNING: This pool has ${activeInvestments.length} active investment(s). Deleting it will unlink those investments from the pool.`
    : '';

  if (!await Confirm.ask(`Delete pool "${name}"?`, { body: `This cannot be undone.${warningLine ? ' ' + warningLine.replace(/\n|⚠️\s*/g, '') : ''}`, confirmLabel: 'Delete Pool', danger: true })) return;

  try {
    await API.pools.delete(id);
    Toast.success(`Pool "${name}" deleted`);
    await loadPools();
  } catch (e) {
    Toast.error(e.message || 'Failed to delete pool');
  }
}

function editPool(id) {
  const pool = STATE.pools.find(p => p.id === id);
  if (!pool) {
    Toast.error('Pool data not loaded — please refresh the page.');
    loadPools();
    return;
  }

  document.getElementById('editPoolId').value          = pool.id;
  document.getElementById('editPoolIdDisplay').value   = pool.id;
  document.getElementById('editPoolName').value        = pool.name || '';
  document.getElementById('editPoolStatus').value      = pool.status || 'open';
  // Populate product-type options from the products catalogue, ensuring this
  // pool's own type is selectable even if the product is now inactive/removed.
  _populateProductTypeDropdowns();
  const editTypeSel = document.getElementById('editPoolType');
  if (pool.product_type && editTypeSel && !Array.from(editTypeSel.options).some(o => o.value === pool.product_type)) {
    editTypeSel.insertAdjacentHTML('beforeend', `<option value="${pool.product_type}">${pool.product_type}</option>`);
  }
  document.getElementById('editPoolType').value        = pool.product_type || 'cattle';
  document.getElementById('editPoolTargetType').value  = pool.target_type || 'amount';
  _syncPoolTargetType('edit');
  document.getElementById('editPoolTerm').value        = pool.term_months || 12;
  document.getElementById('editPoolTarget').value      = pool.target_amount || 0;
  document.getElementById('editPoolRaised').value      = pool.raised_amount || 0;
  document.getElementById('editPoolMin').value         = pool.min_investment || 500;
  document.getElementById('editPoolRate').value        = pool.annual_rate || 0;
  document.getElementById('editPoolActualRate').value  = pool.actual_rate || 0;
  document.getElementById('editPoolPartner').value     = pool.partner_name || '';
  document.getElementById('editPoolInvCount').value    = pool.investor_count || 0;
  // Convert ISO dates to YYYY-MM-DD for date inputs
  const toDateVal = iso => { try { return iso ? new Date(iso).toISOString().split('T')[0] : ''; } catch { return ''; } };
  document.getElementById('editPoolOpenDate').value    = toDateVal(pool.start_date);
  document.getElementById('editPoolCloseDate').value   = toDateVal(pool.end_date);
  // Investment start date: use stored value, or auto-compute as close date + 1 day
  const _invStartFallback = pool.end_date ? (() => { const d = new Date(pool.end_date); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; })() : '';
  document.getElementById('editPoolInvStartDate').value = toDateVal(pool.investment_start_date) || _invStartFallback;
  document.getElementById('editPoolMaturityDate').value = toDateVal(pool.maturity_date);
  document.getElementById('editPoolMaxCapacity').value = pool.max_capacity || '';
  const mgtFeeEl = document.getElementById('editPoolMgtFeePct');
  if (mgtFeeEl) mgtFeeEl.value = pool.management_fee_pct ? (Number(pool.management_fee_pct) * 100).toFixed(4).replace(/\.?0+$/, '') : 0;
  const mgtFeeFreqEl = document.getElementById('editPoolMgtFeeFreq');
  if (mgtFeeFreqEl) mgtFeeFreqEl.value = pool.management_fee_frequency || 'once';
  const opFeeEl = document.getElementById('editPoolOpFeePct');
  if (opFeeEl) opFeeEl.value = pool.operational_fee_pct ? (Number(pool.operational_fee_pct) * 100).toFixed(4).replace(/\.?0+$/, '') : 0;
  const opFeeFreqEl = document.getElementById('editPoolOpFeeFreq');
  if (opFeeFreqEl) opFeeFreqEl.value = pool.operational_fee_frequency || 'annual';
  const notesEl = document.getElementById('editPoolAdminNotes');
  if (notesEl) notesEl.value = pool.admin_notes || '';

  Modal.open('editPoolModal');
}

async function saveEditPool(btn) {
  const id = document.getElementById('editPoolId').value;
  if (!id) return;

  const maxCapVal2 = document.getElementById('editPoolMaxCapacity').value;
  const updates = {
    name:           document.getElementById('editPoolName').value.trim(),
    status:         document.getElementById('editPoolStatus').value,
    product_type:   document.getElementById('editPoolType').value,
    target_type:    document.getElementById('editPoolTargetType')?.value || 'amount',
    term_months:    parseInt(document.getElementById('editPoolTerm').value) || 12,
    target_amount:  parseFloat(document.getElementById('editPoolTarget').value) || 0,
    raised_amount:  parseFloat(document.getElementById('editPoolRaised').value) || 0,
    min_investment: parseFloat(document.getElementById('editPoolMin').value) || 500,
    annual_rate:    parseFloat(document.getElementById('editPoolRate').value) || 0,
    actual_rate:    parseFloat(document.getElementById('editPoolActualRate').value) || 0,
    partner_name:   document.getElementById('editPoolPartner').value.trim(),
    investor_count: parseInt(document.getElementById('editPoolInvCount').value) || 0,
    start_date:            document.getElementById('editPoolOpenDate').value || null,
    end_date:              document.getElementById('editPoolCloseDate').value || null,
    investment_start_date: document.getElementById('editPoolInvStartDate').value || null,
    maturity_date:         document.getElementById('editPoolMaturityDate').value || null,
    max_capacity:   maxCapVal2 ? (parseFloat(maxCapVal2) || null) : null,
    management_fee_pct:        (parseFloat(document.getElementById('editPoolMgtFeePct')?.value) || 0) / 100,
    management_fee_frequency:  document.getElementById('editPoolMgtFeeFreq')?.value || 'once',
    operational_fee_pct:       (parseFloat(document.getElementById('editPoolOpFeePct')?.value) || 0) / 100,
    operational_fee_frequency: document.getElementById('editPoolOpFeeFreq')?.value || 'annual',
    admin_notes:    document.getElementById('editPoolAdminNotes')?.value.trim() || null,
  };

  if (!updates.name) { Toast.error('Pool name is required'); return; }

  await _withBtn(btn, async () => {
    try {
      await API.pools.update(id, updates);
      Toast.success('Pool updated successfully');
      Modal.close('editPoolModal');
      await loadPools();
    } catch (e) {
      Toast.error('Failed to update pool: ' + (e.message || 'unknown error'));
      console.error('[saveEditPool]', e);
    }
  });
}

/* ═══════════════════════════════════════════════
   INVESTMENTS
   ═══════════════════════════════════════════════ */
let invPage = 1;
const INV_PG_SIZE = 10;
let filteredInvests = [];

async function loadInvestments() {
  try {
    const res = await API.investments.list({ limit: 5000 });
    STATE.investments = res.data || [];
    filteredInvests = [...STATE.investments];
    _markRefreshed('investments');
    renderInvestmentStats();
    renderInvestmentsTable();
    setupInvestmentFilters();
  } catch (e) { Toast.error('Failed to load investments'); }
}

function renderInvestmentStats() {
  const d = STATE.investments;
  const active = d.filter(i => i.status === 'active');
  const withRate = active.filter(i => i.annual_rate > 0);
  const avgRate = withRate.length ? withRate.reduce((s,i) => s+(parseFloat(i.annual_rate)||0), 0) / withRate.length : 0;
  const activeCapital = active.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  document.getElementById('inv-total').textContent = d.length.toLocaleString();
  document.getElementById('inv-active').textContent = active.length.toLocaleString();
  document.getElementById('inv-matured').textContent = d.filter(i => i.status === 'matured').length.toLocaleString();
  document.getElementById('inv-capital').textContent = Utils.rand(activeCapital);
  document.getElementById('inv-avgrate').textContent = avgRate ? Utils.pct(avgRate) : '—';
}

function renderInvestmentsTable() {
  const body = document.getElementById('investmentsBody');
  const start = (invPage - 1) * INV_PG_SIZE;
  const page = filteredInvests.slice(start, start + INV_PG_SIZE);

  document.getElementById('investmentsFooter').textContent = `${start + 1}–${Math.min(start + INV_PG_SIZE, filteredInvests.length)} of ${filteredInvests.length}`;

  if (!page.length) {
    body.innerHTML = filteredInvests.length < STATE.investments.length
      ? _emptyRow('fa-filter-circle-xmark', 'No matching investments', 'Try adjusting the search or filters above.', 10)
      : _emptyRow('fa-chart-line', 'No investments yet', 'Investments will appear here once they are created.', 10);
    return;
  }

  body.innerHTML = page.map(i => {
    const pi = Utils.productInfo(i.product_type);
    const investor   = STATE.investors.find(inv => inv.id === i.investor_id);
    const invName    = i.investor_name || (investor ? `${investor.first_name} ${investor.last_name}` : '—');
    const investDate = i.start_date || i.created_at;
    return `<tr tabindex="0">
      <td style="width:36px;text-align:center"><input type="checkbox" class="inv-select-cb" value="${i.id}" onchange="_invUpdateBulkBar()" /></td>
      <td>
        <div class="td-strong clip" style="cursor:pointer" onclick="viewInvestor('${i.investor_id}')">${invName}</div>
        <div class="clip" style="font-size:0.7rem;font-family:monospace;color:var(--text-muted)">${i.investor_id||'—'}</div>
      </td>
      <td class="td-muted clip">${Utils.date(investDate)}</td>
      <td>${i.pool_id
        ? `<div class="td-strong clip" style="cursor:pointer;color:var(--gold)" onclick="viewPoolInvestors('${i.pool_id}')" title="${_esc(i.pool_name||i.pool_id)}">${i.pool_name||i.pool_id}</div>`
        : `<div class="td-muted clip">—</div>`
      }</td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
      <td class="td-green">${i.annual_rate?Utils.pct(i.annual_rate):'—'}</td>
      <td>${Utils.statusBadge(i.status)}</td>
      <td class="td-muted">${Utils.date(i.end_date)}</td>
      <td>
        <button class="btn btn--secondary btn--sm" onclick='viewInvestmentDetail(${JSON.stringify(i.id)})'><i class="fa-solid fa-eye"></i></button>
      </td>
    </tr>`;
  }).join('');

  const pages = Math.ceil(filteredInvests.length / INV_PG_SIZE);
  const pagInv = document.getElementById('investmentsPagination');
  if (pagInv) pagInv.innerHTML = [
    invPage > 1 ? `<button class="page-btn" onclick="invPage--;renderInvestmentsTable()">&#8249; Prev</button>` : `<button class="page-btn" disabled style="opacity:0.35">&#8249; Prev</button>`,
    `<span class="page-btn active" style="cursor:default;min-width:60px;text-align:center">${invPage} / ${pages||1}</span>`,
    invPage < pages ? `<button class="page-btn" onclick="invPage++;renderInvestmentsTable()">Next &#8250;</button>` : `<button class="page-btn" disabled style="opacity:0.35">Next &#8250;</button>`,
  ].join('');

  _setRefreshLabel('investmentsRefreshed', 'investments');
  _invUpdateBulkBar();
}

function _invUpdateBulkBar() {
  const checked = document.querySelectorAll('.inv-select-cb:checked');
  let bar = document.getElementById('invBulkBar');
  if (!bar) return;
  if (checked.length > 0) {
    bar.style.display = 'flex';
    const label = bar.querySelector('#invBulkCount');
    if (label) label.textContent = checked.length;
  } else {
    bar.style.display = 'none';
  }
}

async function bulkTriggerPayout() {
  const checked = [...document.querySelectorAll('.inv-select-cb:checked')].map(cb => cb.value);
  if (!checked.length) return Toast.error('Select at least one investment');
  if (!await Confirm.ask(`Mark ${checked.length} investment(s) matured?`, { body: 'These investments will be marked as matured.', confirmLabel: 'Mark Matured' })) return;
  let done = 0;
  for (const id of checked) {
    try {
      await API.investments.update(id, { status: 'matured', payout_date: new Date().toISOString() });
      done++;
    } catch(e) { console.error('payout error', id, e.message); }
  }
  Toast.success(`${done} investment(s) marked as matured`);
  loadInvestments && loadInvestments();
}

function setupInvestmentFilters() {
  const search = document.getElementById('investmentSearch');
  const product = document.getElementById('investmentProductFilter');
  const status = document.getElementById('investmentStatusFilter');
  const dateFrom = document.getElementById('invDateFrom');
  const dateTo = document.getElementById('invDateTo');
  const sortSel = document.getElementById('investmentSortOrder');

  const filter = Utils.debounce(() => {
    const q = search.value.toLowerCase();
    const pr = product.value;
    const st = status.value;
    const from = dateFrom?.value ? new Date(dateFrom.value) : null;
    const to = dateTo?.value ? new Date(dateTo.value + 'T23:59:59') : null;

    filteredInvests = STATE.investments.filter(i => {
      const investor = STATE.investors.find(inv => inv.id === i.investor_id);
      const invName  = i.investor_name || (investor ? `${investor.first_name} ${investor.last_name}` : '');
      const mq = !q || `${invName} ${i.pool_name} ${i.investor_id||''}`.toLowerCase().includes(q);
      const ipt = i.product_type === 'smme' ? 'short_term' : i.product_type;
      const mp = !pr || ipt === pr;
      const ms = !st || i.status === st;
      const iDate = i.start_date ? new Date(i.start_date) : null;
      const mFrom = !from || (iDate && iDate >= from);
      const mTo = !to || (iDate && iDate <= to);
      return mq && mp && ms && mFrom && mTo;
    });

    const sort = sortSel?.value || '';
    if (sort) {
      filteredInvests = [...filteredInvests].sort((a, b) => {
        if (sort === 'date_desc') return new Date(b.start_date || 0) - new Date(a.start_date || 0);
        if (sort === 'date_asc')  return new Date(a.start_date || 0) - new Date(b.start_date || 0);
        if (sort === 'amount_desc') return (parseFloat(b.amount) || 0) - (parseFloat(a.amount) || 0);
        if (sort === 'amount_asc')  return (parseFloat(a.amount) || 0) - (parseFloat(b.amount) || 0);
        return 0;
      });
    }

    invPage = 1;
    renderInvestmentsTable();
  }, 200);

  search.addEventListener('input', filter);
  product.addEventListener('change', filter);
  status.addEventListener('change', filter);
  if (dateFrom) dateFrom.addEventListener('change', filter);
  if (dateTo) dateTo.addEventListener('change', filter);
  if (sortSel) sortSel.addEventListener('change', filter);
}

function viewInvestmentDetail(id) {
  const inv = STATE.investments.find(i => i.id === id);
  if (!inv) return;
  const pi = Utils.productInfo(inv.product_type);
  const invRecord = STATE.investors.find(i => i.id === inv.investor_id);
  const email = inv.investor_email || invRecord?.email || '—';

  document.getElementById('invDetailTitle').textContent = `Investment — ${inv.pool_name}`;
  document.getElementById('invDetailBody').innerHTML = `
    <div class="grid-2 mb-16" style="gap:12px">
      <div class="info-row"><span class="info-row__label">Investor</span><span class="info-row__value td-strong">${_esc(inv.investor_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Email</span><span class="info-row__value td-muted">${_esc(email)}</span></div>
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${_esc(inv.pool_name)}</span></div>
      <div class="info-row"><span class="info-row__label">Product</span><span class="info-row__value"><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></span></div>
      <div class="info-row"><span class="info-row__label">Invested Amount</span><span class="info-row__value td-gold fw-700">${Utils.rand(inv.amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Target Return</span><span class="info-row__value td-green">${Utils.rand(inv.expected_return)}</span></div>
      <div class="info-row"><span class="info-row__label">Return Rate</span><span class="info-row__value">${Utils.pct(inv.annual_rate)} p.a.</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(inv.status)}</span></div>
      <div class="info-row"><span class="info-row__label">Investment Date</span><span class="info-row__value td-muted">${Utils.date(inv.start_date)}</span></div>
      <div class="info-row"><span class="info-row__label">Maturity Date</span><span class="info-row__value td-muted">${Utils.date(inv.end_date)}</span></div>
      <div class="info-row"><span class="info-row__label">Payout Date</span><span class="info-row__value td-muted">${Utils.date(inv.payout_date) || 'Pending'}</span></div>
      <div class="info-row"><span class="info-row__label">Maturity Instruction</span><span class="info-row__value">${Utils.statusBadge(inv.maturity_instruction || 'pending')}</span></div>
    </div>

    <div class="panel" style="padding:14px;margin-bottom:14px;background:var(--ci-bg-light,#F7F8FA)">
      <div style="font-size:0.8rem;font-weight:700;color:#1a1a1a;margin-bottom:8px"><i class="fa-solid fa-user-pen" style="color:var(--gold);margin-right:6px"></i>Set instruction on behalf of client</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="admMatInstruction" class="form-select" style="flex:1;min-width:180px">
          <option value="reinvest"${inv.maturity_instruction === 'reinvest' ? ' selected' : ''}>Reinvest into next pool</option>
          <option value="payout_all"${inv.maturity_instruction === 'payout_all' ? ' selected' : ''}>Pay out all (capital + returns)</option>
          <option value="payout_return"${inv.maturity_instruction === 'payout_return' ? ' selected' : ''}>Pay out returns only</option>
          <option value="switch_product"${inv.maturity_instruction === 'switch_product' ? ' selected' : ''}>Switch product</option>
        </select>
        <button class="btn btn--primary btn--sm" onclick='adminSetInstruction(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-check"></i> Set Instruction
        </button>
      </div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-top:6px">Admin submissions bypass the 17:00 client cut-off.</div>
    </div>

    ${inv.status === 'active' ? `
      <div class="flex-between" style="gap:10px;flex-wrap:wrap">
        <button class="btn btn--success btn--sm" onclick='markInvestmentMatured(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-hourglass-end"></i> Mark as Matured
        </button>
        <button class="btn btn--primary btn--sm" onclick='payoutInvestment(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-money-bill-transfer"></i> Process Payout
        </button>
        <button class="btn btn--danger btn--sm" onclick='cancelInvestment(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-ban"></i> Cancel &amp; Refund
        </button>
      </div>
    ` : ''}
  `;
  Modal.open('investorDetailModal');
}

async function adminSetInstruction(id) {
  const sel = document.getElementById('admMatInstruction');
  const instruction = sel && sel.value;
  if (!instruction) return;
  try {
    // Uses the dedicated endpoint; staff role bypasses the 17:00 client cut-off.
    await API._fetch('POST', `investments/${id}/instruction`, { instruction });
    Toast.success('Maturity instruction set on behalf of the client');
    Modal.close('investorDetailModal');
    await loadInvestments();
  } catch (e) {
    Toast.error(e.message || 'Failed to set instruction');
  }
}

async function cancelInvestment(id) {
  const inv = STATE.investments.find(i => i.id === id);
  if (!inv) return;
  const confirmed = await Confirm.ask('Cancel Investment & Refund?', {
    body: `This will cancel the investment of <strong>${Utils.rand(inv.amount)}</strong> in <strong>${_esc(inv.pool_name)}</strong> and credit the full amount plus any platform fee back to <strong>${_esc(inv.investor_name)}</strong>'s wallet. This cannot be undone.`,
    confirmLabel: 'Cancel & Refund',
    confirmClass: 'btn--danger',
  });
  if (!confirmed) return;
  try {
    const result = await API._fetch('POST', `investments/${id}/cancel`, { reason: 'Admin cancellation' });
    Toast.success(`Investment cancelled — ${Utils.rand(result.refunded)} refunded to wallet`);
    Modal.close('investorDetailModal');
    await Promise.all([loadInvestments(), loadInvestors()]);
  } catch (e) {
    Toast.error(e.message || 'Failed to cancel investment');
  }
}

async function markInvestmentMatured(id) {
  try {
    await API.investments.update(id, { status: 'matured' });
    Toast.success('Investment marked as matured');
    Modal.close('investorDetailModal');
    await loadInvestments();
  } catch (e) { Toast.error('Failed to update investment'); }
}

async function payoutInvestment(id) {
  const inv = STATE.investments.find(i => i.id === id);
  if (!inv) return;
  const actualRate = prompt(`Enter actual return rate achieved (e.g. 0.1561 for 15.61%):`, inv.annual_rate);
  if (!actualRate) return;
  const rate = parseFloat(actualRate);
  const actualReturn = Math.round(inv.amount * rate * ((new Date(inv.end_date) - new Date(inv.start_date)) / (365 * 86400000)));

  try {
    await API.investments.update(id, {
      status: 'matured',
      actual_return: actualReturn,
      payout_date: new Date().toISOString()
    });
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: inv.investor_id || '',
      type:        'payout',
      amount:      inv.amount + actualReturn,
      status:      'completed',
      reference:   `PAYOUT-${Date.now()}`,
      description: `Maturity payout for ${inv.pool_name || inv.pool_id}`,
      pool_id:     inv.pool_id || '',
    });
    Toast.success(`Payout processed: ${Utils.rand(inv.amount + actualReturn)} → ${inv.investor_name}`);
    Modal.close('investorDetailModal');
    await loadInvestments();
  } catch (e) { Toast.error('Failed to process payout'); }
}

/* ═══════════════════════════════════════════════
   MATURITY
   ═══════════════════════════════════════════════ */
const _matInstrLabel = { payout_all: 'Payout All', payout_return: 'Payout Returns', reinvest: 'Reinvest', payout_custom: 'Custom Payout', switch_product: 'Switch Product', pending: 'Pending' };
let filteredMaturity = [];

async function loadMaturity() {
  try {
    const [matRes, invRes, investRes] = await Promise.all([
      API.maturityInstructions.list({ limit: 1000 }),
      STATE.investors.length  ? Promise.resolve({ data: STATE.investors  }) : API.investors.list({ limit: 5000 }),
      API.investments.list({ limit: 5000 })  // always fresh — maturity_instruction may have changed
    ]);

    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    STATE.investments = investRes.data || [];

    const matRecords = matRes.data || [];

    /* Build a set of investor_ids already covered by a real maturity_instructions record */
    const covered = new Set(matRecords.map(m => m.investor_id + '|' + (m.pool_id || '')));

    /* Derive instructions from migrated investments */
    const fromInvestments = STATE.investments
      .filter(i => i.maturity_instruction && i.maturity_instruction !== 'pending' && !covered.has(i.investor_id + '|' + (i.pool_id || '')))
      .map(i => {
        const inv = STATE.investors.find(x => x.id === i.investor_id);
        return {
          id:               i.id,
          investor_id:      i.investor_id,
          investor_name:    inv ? `${inv.first_name} ${inv.last_name}`.trim() : i.investor_id,
          pool_id:          i.pool_id,
          pool_name:        i.pool_name || '—',
          instruction_type: i.maturity_instruction,
          total_payout:     i.amount,
          status:           i.status === 'matured' ? 'completed' : (i.status === 'active' ? 'submitted' : i.status),
          submitted_date:   i.end_date || i.start_date || i.created_at,
          _from_investment: true,
        };
      });

    STATE.maturity = [...matRecords, ...fromInvestments]
      .sort((a, b) => new Date(b.submitted_date || b.created_at || 0) - new Date(a.submitted_date || a.created_at || 0));

    filteredMaturity = [...STATE.maturity];
    _applyMaturityFilters();
  } catch (e) { Toast.error('Failed to load maturity instructions'); }
}

function renderMaturityTable() {
  const body = document.getElementById('maturityBody');
  const countEl = document.getElementById('maturityCount');
  const rows = filteredMaturity;
  if (countEl) countEl.textContent = `${rows.length.toLocaleString()} of ${(STATE.maturity || []).length.toLocaleString()} instructions`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:32px"><i class="fa-solid fa-inbox" style="font-size:1.5rem;color:var(--text-dim);display:block;margin-bottom:8px"></i>No maturity instructions match the current filters</td></tr>';
    return;
  }
  body.innerHTML = rows.map(m => {
    const mInv = STATE.investors.find(i => i.id === m.investor_id);
    const mName = m.investor_name || (mInv ? `${mInv.first_name} ${mInv.last_name}`.trim() : m.investor_id || '—');
    const instrLabel = _matInstrLabel[m.instruction_type] || (m.instruction_type?.replace(/_/g, ' ') || '—');
    return `
    <tr>
      <td><div class="td-strong clip">${mName}</div><div class="td-muted clip" style="font-size:0.7rem">${m.investor_id||''}</div></td>
      <td class="td-muted clip" title="${_esc(m.pool_name || '')}">${m.pool_name || '—'}</td>
      <td><span class="badge badge--blue">${instrLabel}</span></td>
      <td class="td-gold fw-700">${m.total_payout ? Utils.rand(m.total_payout) : '—'}</td>
      <td>${Utils.statusBadge(m.status)}</td>
      <td class="td-muted">${Utils.date(m.submitted_date || m.created_at)}</td>
      <td>
        ${m.status === 'submitted' && !m._from_investment ? `<button class="btn btn--success btn--sm" onclick='processMaturity(${JSON.stringify(m.id)})'><i class="fa-solid fa-play"></i> Process</button>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

function _applyMaturityFilters() {
  const q      = (document.getElementById('maturitySearch')?.value || '').toLowerCase().trim();
  const st     = document.getElementById('maturityStatusFilter')?.value || '';
  const instr  = document.getElementById('maturityInstrFilter')?.value || '';
  const dFrom  = document.getElementById('maturityDateFrom')?.value || '';
  const dTo    = document.getElementById('maturityDateTo')?.value || '';

  filteredMaturity = STATE.maturity.filter(m => {
    const mInv  = STATE.investors.find(i => i.id === m.investor_id);
    const name  = (m.investor_name || (mInv ? `${mInv.first_name} ${mInv.last_name}` : '') || '').toLowerCase();
    const pool  = (m.pool_name || '').toLowerCase();
    const matchQ     = !q     || name.includes(q) || pool.includes(q) || (m.investor_id || '').toLowerCase().includes(q);
    const matchSt    = !st    || m.status === st;
    const matchInstr = !instr || m.instruction_type === instr;
    const mDate = m.submitted_date || m.created_at || '';
    const matchFrom  = !dFrom || mDate.slice(0, 10) >= dFrom;
    const matchTo    = !dTo   || mDate.slice(0, 10) <= dTo;
    return matchQ && matchSt && matchInstr && matchFrom && matchTo;
  });

  renderMaturityTable();
}

function _clearMaturityFilters() {
  ['maturitySearch','maturityDateFrom','maturityDateTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['maturityStatusFilter','maturityInstrFilter'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _applyMaturityFilters();
}

async function processMaturity(id) {
  if (!await Confirm.ask('Process maturity instruction?', { body: 'This will mark the instruction as processing and begin the payout or reinvestment flow.', confirmLabel: 'Process' })) return;
  try {
    const m = STATE.maturity.find(x => x.id === id);
    if (!m) { Toast.error('Instruction not found — refresh and try again'); return; }
    await API.maturityInstructions.update(id, { status: 'processing' });
    Toast.success('Maturity instruction marked as processing');
    await loadMaturity();
  } catch (e) {
    Toast.error('Failed to process instruction: ' + (e.message || 'unknown error'));
    console.error('[processMaturity]', e);
  }
}

async function processAllMaturity() {
  const pending = (STATE.maturity || []).filter(m => m.status === 'submitted' && !m._from_investment);
  if (!pending.length) { Toast.info('No submitted instructions to process'); return; }
  if (!await Confirm.ask(`Process all ${pending.length} submitted maturity instructions?`, {
    body: 'Each instruction will be marked as processing. This cannot be undone.',
    confirmLabel: 'Process All',
  })) return;
  let ok = 0, fail = 0;
  for (const m of pending) {
    try { await API.maturityInstructions.update(m.id, { status: 'processing' }); ok++; }
    catch (e) { console.error('[processAllMaturity]', m.id, e); fail++; }
  }
  if (fail) Toast.warning(`${ok} processed, ${fail} failed`);
  else Toast.success(`${ok} maturity instructions marked as processing`);
  await loadMaturity();
}

/* ═══════════════════════════════════════════════
   TRANSACTIONS
   ═══════════════════════════════════════════════ */
let txnPage = 1;
const TXN_PG_SIZE = 10;
let filteredTxns = [];

async function loadTransactions() {
  try {
    const [txnRes, invRes] = await Promise.all([
      API.transactions.list({ limit: 5000 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 })
    ]);
    STATE.transactions = txnRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    filteredTxns = [...STATE.transactions];
    _markRefreshed('transactions');
    renderTxnStats();
    renderTxnTable();
    setupTxnFilters();
  } catch (e) { Toast.error('Failed to load transactions'); }
}

function renderTxnStats() {
  const d = STATE.transactions;
  document.getElementById('txn-deposits').textContent = Utils.rand(d.filter(t => t.type === 'deposit').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
  document.getElementById('txn-invested').textContent = Utils.rand(Math.abs(d.filter(t => t.type === 'investment').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0)));
  document.getElementById('txn-returns').textContent  = Utils.rand(d.filter(t => t.type === 'return').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0));
  document.getElementById('txn-count').textContent    = d.length;
}

function _txnInvName(t) {
  const inv = STATE.investors.find(i => i.id === t.investor_id);
  return inv ? `${inv.first_name} ${inv.last_name}` : (t.investor_id || '—');
}

function renderTxnTable() {
  const body = document.getElementById('txnBody');
  const start = (txnPage - 1) * TXN_PG_SIZE;
  const page = filteredTxns.sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at)).slice(start, start + TXN_PG_SIZE);

  document.getElementById('txnFooter').textContent = `${start + 1}–${Math.min(start + TXN_PG_SIZE, filteredTxns.length)} of ${filteredTxns.length}`;

  if (!page.length) {
    body.innerHTML = filteredTxns.length < STATE.transactions.length
      ? _emptyRow('fa-filter-circle-xmark', 'No matching transactions', 'Try clearing the search or type filter.', 8)
      : _emptyRow('fa-arrows-rotate', 'No transactions yet', 'Transactions will appear here once investors make deposits or withdrawals.', 8);
    return;
  }

  const typeColors = { deposit: 'green', withdrawal: 'red', investment: 'blue', reinvestment: 'purple', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple' };

  body.innerHTML = page.map(t => {
    const isPendingDeposit = t.type === 'deposit' && t.status === 'pending';
    const statusCell = isPendingDeposit
      ? `<select class="tbl-filter" style="font-size:0.72rem;padding:4px 8px;border-radius:6px;border:1.5px solid rgba(255,130,21,0.4);background:var(--dark-4);color:var(--text);cursor:pointer" onchange="changeTxnStatus('${t.id}', this.value, '${t.investor_id}', ${t.amount})">
           <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
           <option value="processing" ${t.status==='processing'?'selected':''}>Processing</option>
           <option value="completed" ${t.status==='completed'?'selected':''}>Completed</option>
           <option value="failed" ${t.status==='failed'?'selected':''}>Failed</option>
         </select>`
      : Utils.statusBadge(t.status);

    const proofLink = (t.proof_attached && t.proof_filename)
      ? `<a href="#" onclick="viewEftProof('${t.id}')" style="display:inline-flex;align-items:center;gap:4px;font-size:0.7rem;color:#fec24f;font-weight:600;margin-top:2px"><i class="fa-solid fa-paperclip"></i> ${t.proof_filename}</a>`
      : '';

    const invName = _txnInvName(t);

    return `<tr>
      <td><div class="td-strong clip">${invName}</div></td>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${t.type?.replace(/_/g, ' ') || '—'}</span></td>
      <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
      <td>${statusCell}</td>
      <td class="td-muted clip" style="font-size:0.75rem">${t.reference || '—'}${t.reference ? `<button class="copy-btn" onclick='copyToClipboard(${JSON.stringify(t.reference)},this)' title="Copy reference"><i class="fa-regular fa-copy"></i></button>` : ''}</td>
      <td class="td-muted" style="font-size:0.75rem"><div class="clip">${t.description || '—'}</div>${proofLink}</td>
      <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
      <td>
        ${isPendingDeposit ? `<button class="btn btn--success btn--sm" onclick="changeTxnStatus('${t.id}', 'completed', '${t.investor_id}', ${t.amount})" title="Approve deposit — credits wallet"><i class="fa-solid fa-check"></i> Approve</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const pages = Math.ceil(filteredTxns.length / TXN_PG_SIZE);
  const pagTxn = document.getElementById('txnPagination');
  if (pagTxn) pagTxn.innerHTML = [
    txnPage > 1 ? `<button class="page-btn" onclick="txnPage--;renderTxnTable()">&#8249; Prev</button>` : `<button class="page-btn" disabled style="opacity:0.35">&#8249; Prev</button>`,
    `<span class="page-btn active" style="cursor:default;min-width:60px;text-align:center">${txnPage} / ${pages||1}</span>`,
    txnPage < pages ? `<button class="page-btn" onclick="txnPage++;renderTxnTable()">Next &#8250;</button>` : `<button class="page-btn" disabled style="opacity:0.35">Next &#8250;</button>`,
  ].join('');
  _setRefreshLabel('txnRefreshed', 'transactions');
}

function setupTxnFilters() {
  const search = document.getElementById('txnSearch');
  const type = document.getElementById('txnTypeFilter');
  const dateFrom = document.getElementById('txnDateFrom');
  const dateTo = document.getElementById('txnDateTo');

  const filter = Utils.debounce(() => {
    const q = search.value.toLowerCase();
    const tp = type.value;
    const from = dateFrom?.value ? new Date(dateFrom.value) : null;
    const to = dateTo?.value ? new Date(dateTo.value + 'T23:59:59') : null;
    filteredTxns = STATE.transactions.filter(t => {
      const invName = _txnInvName(t);
      const mq = !q || `${invName} ${t.reference} ${t.description}`.toLowerCase().includes(q);
      const mt = !tp || t.type === tp;
      const txDate = t.created_at ? new Date(t.created_at) : null;
      const mFrom = !from || (txDate && txDate >= from);
      const mTo = !to || (txDate && txDate <= to);
      return mq && mt && mFrom && mTo;
    });
    txnPage = 1;
    renderTxnTable();
  }, 200);

  search.addEventListener('input', filter);
  type.addEventListener('change', filter);
  if (dateFrom) dateFrom.addEventListener('change', filter);
  if (dateTo) dateTo.addEventListener('change', filter);
}

let _cancelTxnPending = null; // { txnId, investorId, amount }

function openCancelTxnModal(txnId, investorId, amount) {
  _cancelTxnPending = { txnId, investorId, amount };
  const noteEl = document.getElementById('cancelTxnNote');
  if (noteEl) noteEl.value = '';
  Modal.open('cancelTxnModal');
}

async function confirmCancelTxn() {
  if (!_cancelTxnPending) return;
  const note = (document.getElementById('cancelTxnNote')?.value || '').trim();
  if (!note) { Toast.error('Please enter a cancellation note'); return; }
  Modal.close('cancelTxnModal');
  await changeTxnStatus(_cancelTxnPending.txnId, 'failed', _cancelTxnPending.investorId, _cancelTxnPending.amount, note);
  _cancelTxnPending = null;
}

async function changeTxnStatus(txnId, newStatus, investorId, amount, cancelNote) {
  // 'failed' always requires a note — open the modal if called without one
  if (newStatus === 'failed' && !cancelNote) {
    openCancelTxnModal(txnId, investorId, amount);
    return;
  }
  try {
    const txn = STATE.transactions.find(t => t.id === txnId);
    if (!txn) return;

    const patch = { status: newStatus };
    if (cancelNote) {
      patch.description = txn.description
        ? `${txn.description} | Cancelled: ${cancelNote}`
        : `Cancelled: ${cancelNote}`;
    }
    await API.transactions.update(txnId, patch);

    // If approving a pending deposit to completed, credit the investor's wallet
    if (newStatus === 'completed' && txn.status !== 'completed' && txn.type === 'deposit' && investorId && amount > 0) {
      const investor = STATE.investors.find(i => i.id === investorId);
      if (investor) {
        const newBalance = Math.round(((investor.wallet_balance || 0) + amount) * 100) / 100;
        await API.investors.update(investorId, { wallet_balance: newBalance });
        Toast.success(`Deposit approved — R${amount.toLocaleString('en-ZA', {minimumFractionDigits:2})} credited to ${investor.first_name} ${investor.last_name}'s wallet`);
      } else {
        Toast.success('Transaction status updated to completed');
      }
    } else if (newStatus === 'failed') {
      Toast.success('Transaction cancelled — note saved');
    } else {
      Toast.success(`Transaction status updated to ${newStatus}`);
    }
    await loadTransactions();
  } catch (e) {
    Toast.error('Failed to update transaction status');
    console.error(e);
  }
}

async function viewEftProof(txnId) {
  const txn = STATE.transactions.find(t => t.id === txnId);
  if (!txn) return;
  // Open the support ticket that contains the proof if it exists
  try {
    const res = await API.tickets.list({ limit: 200 });
    const ticket = (res.data || []).find(t => t.subject && t.subject.includes(txn.reference));
    if (ticket) {
      viewTicket(ticket.id);
    } else {
      Toast.info('Proof of payment is attached in the support ticket — check Support Tickets section');
    }
  } catch (e) {
    Toast.info('Check Support Tickets for the EFT proof of payment');
  }
}

function openAddTxnModal() {
  /* Reset hidden investor value */
  const hiddenSel = document.getElementById('txnInvestorSelect');
  if (hiddenSel) hiddenSel.value = '';

  /* Investor search-as-you-type */
  const txnSearch = document.getElementById('txnInvSearchInput');
  const txnDrop   = document.getElementById('txnInvDropdown');
  if (txnSearch && txnDrop) {
    txnSearch.value = '';
    txnDrop.style.display = 'none';
    txnDrop.innerHTML = '';

    function _txnRenderDropdown(q) {
      const term = q.trim().toLowerCase();
      if (!term) { txnDrop.style.display = 'none'; return; }
      const matches = STATE.investors.filter(inv => {
        const name  = `${inv.first_name || ''} ${inv.last_name || ''}`.toLowerCase();
        const id    = (inv.id    || '').toLowerCase();
        const email = (inv.email || '').toLowerCase();
        return name.includes(term) || id.includes(term) || email.includes(term);
      }).slice(0, 25);
      if (!matches.length) { txnDrop.style.display = 'none'; return; }
      txnDrop.innerHTML = matches.map(inv => {
        const name = `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || '—';
        const emailLine = inv.email
          ? `<span style="color:var(--text-muted);font-size:0.77rem">${inv.email}</span>` : '';
        return `<li data-id="${inv.id}" data-name="${name}" style="padding:9px 14px;cursor:pointer;display:flex;flex-direction:column;gap:2px">
          <span style="font-weight:600;font-size:0.87rem">${name}
            <span style="color:var(--text-muted);font-weight:400;font-size:0.8rem">(${inv.id})</span>
          </span>
          ${emailLine}
        </li>`;
      }).join('');
      txnDrop.style.display = 'block';
      txnDrop.querySelectorAll('li').forEach(li => {
        li.onmouseenter = () => li.style.background = 'rgba(255,255,255,0.06)';
        li.onmouseleave = () => li.style.background = '';
        li.onclick = () => {
          document.getElementById('txnInvestorSelect').value = li.dataset.id;
          txnSearch.value = `${li.dataset.name} (${li.dataset.id})`;
          txnDrop.style.display = 'none';
        };
      });
    }

    txnSearch.oninput = () => _txnRenderDropdown(txnSearch.value);
    txnSearch.onfocus = () => { if (txnSearch.value) _txnRenderDropdown(txnSearch.value); };
    setTimeout(() => {
      const _closeTxnDrop = e => {
        if (!txnSearch.contains(e.target) && !txnDrop.contains(e.target)) {
          txnDrop.style.display = 'none';
          document.removeEventListener('click', _closeTxnDrop);
        }
      };
      document.addEventListener('click', _closeTxnDrop);
    }, 0);
  }
  Modal.open('addTxnModal');
}

async function saveNewTxn(btn) {
  const investorId = document.getElementById('txnInvestorSelect').value;
  const amount     = parseFloat(document.getElementById('txnAmount').value);
  const type       = document.getElementById('txnType').value;
  const status     = document.getElementById('txnStatus').value;
  if (!investorId || !amount) { Toast.error('Investor and amount required'); return; }

  const investor = STATE.investors.find(i => i.id === investorId);

  await _withBtn(btn, async () => {
    try {
      await API.transactions.create({
        id:          Utils.genId('TXN'),
        investor_id: investorId,
        type,
        amount:      type === 'investment' || type === 'reinvestment' || type === 'withdrawal' ? -Math.abs(amount) : Math.abs(amount),
        status,
        reference:   document.getElementById('txnRef').value.trim(),
        description: document.getElementById('txnDesc').value.trim(),
      });

      // Credit wallet immediately for completed deposits
      if (status === 'completed' && type === 'deposit' && investor) {
        const newBal = Math.round(((investor.wallet_balance || 0) + Math.abs(amount)) * 100) / 100;
        await API.investors.update(investorId, { wallet_balance: newBal });
        Toast.success(`Transaction recorded — R${amount.toLocaleString('en-ZA', {minimumFractionDigits:2})} added to ${investor.first_name} ${investor.last_name}'s wallet`);
      } else {
        Toast.success('Transaction recorded');
      }
      Modal.close('addTxnModal');
      await loadTransactions();
    } catch (e) {
      Toast.error('Failed to record transaction: ' + (e.message || 'unknown error'));
      console.error('[saveNewTxn]', e);
    }
  });
}

/* ═══════════════════════════════════════════════
   SUPPORT TICKETS
   ═══════════════════════════════════════════════ */
function openCreateTicketModal() {
  const sel = document.getElementById('newTicketInvestorId');
  if (sel) {
    const opts = STATE.investors.map(i =>
      `<option value="${_esc(String(i.id))}">${_esc(`${i.first_name} ${i.last_name}`)} — ${_esc(i.email || '')}</option>`
    ).join('');
    sel.innerHTML = '<option value="">Select investor…</option>' + opts;
  }
  ['newTicketSubject','newTicketDescription'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  Modal.open('createTicketModal');
}

async function saveNewTicket(btn) {
  const investorId = document.getElementById('newTicketInvestorId')?.value;
  const subject = document.getElementById('newTicketSubject')?.value?.trim();
  const description = document.getElementById('newTicketDescription')?.value?.trim();
  const category = document.getElementById('newTicketCategory')?.value || 'general';
  const priority = document.getElementById('newTicketPriority')?.value || 'medium';
  if (!subject) { Toast.error('Subject is required'); return; }
  await _withBtn(btn, async () => {
    try {
      const investor = investorId ? STATE.investors.find(i => String(i.id) === investorId) : null;
      await API._fetch('POST', 'tables/support_tickets', {
        investor_id: investorId || null,
        investor_name: investor ? `${investor.first_name} ${investor.last_name}` : null,
        subject,
        description,
        category,
        priority,
        status: 'open',
        source: 'admin',
      });
      Toast.success('Ticket created');
      Modal.close('createTicketModal');
      await loadSupport();
    } catch (e) { Toast.error('Failed to create ticket: ' + (e.message || 'unknown')); }
  });
}

async function loadSupport() {
  try {
    const [tktRes, invRes] = await Promise.all([
      API.tickets.list({ limit: 200 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 })
    ]);
    STATE.tickets = tktRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderTicketStats();
    renderTicketsTable();
    setupTicketFilters();
    document.getElementById('ticketBadge').textContent = _supportTickets().filter(t => ['open', 'in_progress'].includes(t.status)).length;
  } catch (e) { Toast.error('Failed to load support tickets'); }
}

const _SUPPORT_EXCLUDED_CATS = new Set(['bank_verification', 'bank verification']);

function _supportTickets() {
  return STATE.tickets.filter(t => !_SUPPORT_EXCLUDED_CATS.has((t.category || '').toLowerCase()));
}

function renderTicketStats() {
  const d = _supportTickets();
  document.getElementById('tkt-open').textContent        = d.filter(t => t.status === 'open').length;
  document.getElementById('tkt-inprogress').textContent  = d.filter(t => t.status === 'in_progress').length;
  document.getElementById('tkt-resolved').textContent    = d.filter(t => t.status === 'resolved').length;
  document.getElementById('tkt-urgent').textContent      = d.filter(t => ['high', 'urgent'].includes(t.priority)).length;
}

function renderTicketsTable() {
  const body = document.getElementById('ticketsBody');
  const stFilter = document.getElementById('ticketStatusFilter').value;
  const prFilter = document.getElementById('ticketPriorityFilter').value;
  const items = _supportTickets().filter(t => (!stFilter || t.status === stFilter) && (!prFilter || t.priority === prFilter));

  if (!items.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No tickets found</td></tr>'; return; }

  body.innerHTML = items.map(t => {
    const inv      = STATE.investors.find(i => i.id === t.investor_id);
    const invName  = t.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : t.investor_id || '—');
    const invEmail = t.investor_email || inv?.email || '';
    const needsReply = !t.admin_response && t.status === 'open';
    return `<tr ${needsReply ? 'style="background:rgba(254,194,79,0.05)"' : ''}>
      <td><div class="td-strong clip">${invName}</div><div class="td-muted clip">${invEmail}</div></td>
      <td class="td-strong clip">${t.subject}</td>
      <td><span class="badge badge--gray">${t.category?.replace(/_/g, ' ') || '—'}</span></td>
      <td>${Utils.priorityBadge(t.priority)}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted">${t.assigned_to || '—'}</td>
      <td class="td-muted">${Utils.date(t.created_at)}</td>
      <td>
        <button class="btn btn--${needsReply ? 'primary' : 'secondary'} btn--sm" onclick='viewTicket(${JSON.stringify(t.id)})'><i class="fa-solid fa-${needsReply ? 'reply' : 'eye'}"></i> ${needsReply ? 'Reply' : 'View'}</button>
      </td>
    </tr>`;
  }).join('');
}

function setupTicketFilters() {
  const sf = document.getElementById('ticketStatusFilter');
  const pf = document.getElementById('ticketPriorityFilter');
  if (sf && sf._wired) return;
  if (sf) { sf._wired = true; sf.addEventListener('change', renderTicketsTable); }
  if (pf && !pf._wired) { pf._wired = true; pf.addEventListener('change', renderTicketsTable); }
}

async function viewTicket(id) {
  let tkt = STATE.tickets.find(t => t.id === id);
  if (!tkt) return;

  // Fetch the full ticket record directly to get file_url (list responses may omit large columns)
  try {
    const fresh = await API.tickets.get(id);
    if (fresh && fresh.id) {
      // Merge into STATE so subsequent calls see the data too
      const idx = STATE.tickets.findIndex(t => t.id === id);
      if (idx !== -1) STATE.tickets[idx] = { ...tkt, ...fresh };
      tkt = STATE.tickets[idx] || fresh;
    }
  } catch (_) {}

  const tktInv     = STATE.investors.find(i => i.id === tkt.investor_id);
  const tktInvName = tkt.investor_name || (tktInv ? `${tktInv.first_name} ${tktInv.last_name}` : tkt.investor_id || '—');
  const tktEmail   = tkt.investor_email || tktInv?.email || '';

  // Load employees for the "Assigned To" dropdown
  let adminUsers = [];
  try {
    const uRes = await API._fetch('GET', 'tables/employees', null, { limit: 200, sort: 'first_name', order: 'asc' });
    adminUsers = (uRes.data || uRes || []).filter(u => u.status === 'active' || !u.status);
  } catch (_) {}

  const assignedOpts = [
    `<option value="">— Unassigned —</option>`,
    ...adminUsers.map(u => {
      const name  = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
      const val   = u.email;
      const sel   = tkt.assigned_to === val ? 'selected' : '';
      return `<option value="${val}" ${sel}>${name}</option>`;
    }),
  ].join('');

  const _cat = (tkt.category || '').replace(/ /g, '_').toLowerCase();
  const isBankVerification = _cat === 'bank_verification';
  const isFicaSubmission   = _cat === 'fica_submission' || _cat === 'fica' || _cat === 'kyc';

  // Extract base64 data URL embedded in message.
  // EFT format:     "\nData URL: data:..."
  // Ticket format:  "\nData: data:..."
  const msgStr = tkt.message || '';
  let attachDataUrl = tkt.file_url || null;
  let cleanMessage  = msgStr;
  const MARKERS = ['\nData URL:', '\nData:'];
  for (const marker of MARKERS) {
    const idx = msgStr.indexOf(marker);
    if (idx !== -1) {
      const rawUrl = msgStr.slice(idx + marker.length).trim();
      if (rawUrl.startsWith('data:')) {
        attachDataUrl = attachDataUrl || rawUrl;
        cleanMessage  = msgStr.slice(0, idx).trim();
        break;
      }
    }
  }

  const hasProof       = !!(tkt.proof_attached || tkt.proof_filename || tkt.file_url || attachDataUrl);
  const isPaymentProof = tkt.category === 'payment_proof';
  const showActionBtns = (isBankVerification || isFicaSubmission || isPaymentProof || hasProof) && tkt.status !== 'resolved' && tkt.status !== 'closed';

  // Cache doc data to avoid embedding large base64 strings in onclick attributes
  _ticketDocCache[tkt.id] = attachDataUrl || null;

  document.getElementById('ticketModalTitle').textContent = `Ticket #${tkt.id} — ${tkt.subject}`;
  document.getElementById('ticketModalBody').innerHTML = `
    <div class="grid-2 mb-16" style="gap:12px">
      <div class="info-row"><span class="info-row__label">Investor</span><span class="info-row__value">${_esc(tktInvName)}${tktEmail ? ` <span style="color:var(--text-muted);font-size:0.78rem">&lt;${_esc(tktEmail)}&gt;</span>` : ''}</span></div>
      <div class="info-row"><span class="info-row__label">Category</span><span class="info-row__value">${_esc(tkt.category?.replace(/_/g, ' '))}</span></div>
      <div class="info-row"><span class="info-row__label">Priority</span><span class="info-row__value">${Utils.priorityBadge(tkt.priority)}</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(tkt.status)}</span></div>
      <div class="info-row"><span class="info-row__label">Submitted</span><span class="info-row__value td-muted">${Utils.date(tkt.created_at)}</span></div>
      ${tkt.responded_at ? `<div class="info-row"><span class="info-row__label">Last Response</span><span class="info-row__value td-muted">${Utils.date(tkt.responded_at)}</span></div>` : ''}
    </div>
    ${hasProof ? `<div class="panel mb-12" style="border:1.5px solid rgba(254,194,79,0.3)">
      <div class="panel__header" style="background:rgba(254,194,79,0.08)">
        <span class="panel__title"><i class="fa-solid fa-paperclip" style="color:#fec24f;margin-right:6px"></i>Document Attached</span>
      </div>
      <div class="panel__body" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        ${tkt.proof_filename ? `<span style="font-size:0.85rem;font-weight:600"><i class="fa-solid fa-file" style="color:#fec24f;margin-right:6px"></i>${_esc(tkt.proof_filename)}</span>` : ''}
        ${attachDataUrl
          ? `<button class="btn btn--secondary btn--sm" onclick='_openTicketDoc(${JSON.stringify(tkt.id)},${JSON.stringify(tkt.proof_filename||"attachment")})'><i class="fa-solid fa-eye"></i> View</button>
             <button class="btn btn--ghost btn--sm" onclick='_downloadTicketDoc(${JSON.stringify(tkt.id)},${JSON.stringify(tkt.proof_filename||"attachment")})'><i class="fa-solid fa-download"></i> Download</button>`
          : `<span style="font-size:0.75rem;color:var(--text-muted);font-style:italic">File data unavailable — re-upload below</span>`}
        <label class="btn btn--ghost btn--sm" style="cursor:pointer;margin-left:auto" title="Replace document">
          <i class="fa-solid fa-upload"></i> Re-upload
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" style="display:none" onchange='_reuploadTicketFile(event,${JSON.stringify(tkt.id)})'>
        </label>
      </div>
    </div>` : ''}
    ${isBankVerification && tkt.investor_id ? `<div class="panel mb-12" style="border:1.5px solid rgba(237,165,255,0.25)">
      <div class="panel__header" style="background:rgba(237,165,255,0.07);display:flex;align-items:center;gap:10px">
        <span class="panel__title"><i class="fa-solid fa-building-columns" style="color:#eda5ff;margin-right:6px"></i>Proof of Bank Account</span>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <button class="btn btn--secondary btn--sm" id="bankAutoVerifyBtn" onclick='_runBankAutoVerify(${JSON.stringify(tkt.investor_id)})'><i class="fa-solid fa-robot"></i> Auto-Verify</button>
        </div>
      </div>
      <div id="bankProofPreview" style="padding:12px 16px;font-size:0.82rem;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading document…</div>
      <div id="bankVerifyResult" style="padding:0 16px 12px;font-size:0.82rem;color:var(--text-muted)"></div>
    </div>` : ''}
    ${isFicaSubmission && tkt.investor_id ? `<div class="panel mb-12" style="border:1.5px solid rgba(237,165,255,0.25)">
      <div class="panel__header" style="background:rgba(237,165,255,0.07)">
        <span class="panel__title"><i class="fa-solid fa-id-card-clip" style="color:#eda5ff;margin-right:6px"></i>Submitted FICA Documents</span>
      </div>
      <div id="kycDocsPreviewBody" style="padding:12px 16px;font-size:0.82rem;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> Loading documents…</div>
    </div>` : ''}
    ${showActionBtns ? `<div style="display:flex;gap:10px;margin-bottom:16px;padding:12px;background:${isPaymentProof ? 'rgba(34,197,94,0.06)' : 'rgba(237,165,255,0.06)'};border-radius:8px;border:1px solid ${isPaymentProof ? 'rgba(34,197,94,0.2)' : 'rgba(237,165,255,0.15)'}">
      <div style="flex:1">
        <div style="font-size:0.78rem;font-weight:700;color:var(--text);margin-bottom:4px">${isPaymentProof ? 'EFT Deposit Approval' : isBankVerification ? 'Bank Account Verification' : 'Document Review'}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">${isPaymentProof ? 'Approving will credit the investor\'s wallet with the EFT amount and resolve this ticket.' : `Approve or decline the submitted ${isBankVerification ? 'bank account details' : 'documents'}. This will update the investor record.`}</div>
      </div>
      <button class="btn btn--success btn--sm" id="ticketApproveBtn"><i class="fa-solid fa-check"></i> Approve${isPaymentProof ? ' &amp; Credit Wallet' : ''}</button>
      <button class="btn btn--danger btn--sm" id="ticketDeclineBtn"><i class="fa-solid fa-xmark"></i> Decline</button>
    </div>` : ''}
    <div class="panel mb-12">
      <div class="panel__header"><span class="panel__title">Investor Message</span></div>
      <div class="panel__body" style="font-size:0.85rem;color:var(--text-muted);white-space:pre-wrap">${_esc(cleanMessage) || '—'}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Admin Response</label>
      <textarea class="form-textarea" id="ticketResponse" rows="4" placeholder="Write your response...">${tkt.admin_response || ''}</textarea>
    </div>
    <div class="form-row form-row--2">
      <div class="form-group">
        <label class="form-label">Update Status</label>
        <select class="form-select" id="ticketStatusUpdate">
          <option value="open" ${tkt.status === 'open' ? 'selected' : ''}>Open</option>
          <option value="in_progress" ${tkt.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
          <option value="waiting_investor" ${tkt.status === 'waiting_investor' ? 'selected' : ''}>Waiting on Investor</option>
          <option value="resolved" ${tkt.status === 'resolved' ? 'selected' : ''}>Resolved</option>
          <option value="closed" ${tkt.status === 'closed' ? 'selected' : ''}>Closed</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Assign To</label>
        <select class="form-select" id="ticketAssigned">${assignedOpts}</select>
      </div>
    </div>
  `;

  if (showActionBtns && tkt.investor_id) {
    const _doTicketAction = async (approve) => {
      let confirmMsg, invUpdate = null;

      if (isPaymentProof) {
        // Parse amount from subject: "EFT Proof of Payment — Name — R10 000 — EFT-..."
        const amtMatch = (tkt.subject || '').match(/R([\d\s,]+)/);
        const rawAmt   = amtMatch ? amtMatch[1].replace(/[\s,]/g, '') : null;
        const amount   = rawAmt ? parseFloat(rawAmt) : null;
        const refMatch = (tkt.subject || '').match(/EFT-[\w]+/);
        const ref      = refMatch ? refMatch[0] : (tkt.id || '');

        if (approve && (!amount || amount <= 0)) {
          Toast.error('Could not parse EFT amount from ticket subject. Please verify manually.');
          return;
        }
        confirmMsg = approve
          ? `Credit R${amount?.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} to ${tktInvName}'s wallet? This cannot be undone.`
          : 'Decline this EFT deposit? The investor will be notified to resubmit proof.';
        if (!await Confirm.ask(approve ? 'Approve EFT Deposit' : 'Decline EFT Deposit', { body: confirmMsg, confirmLabel: approve ? 'Approve & Credit' : 'Decline', danger: !approve })) return;
        try {
          if (approve) {
            // The portal pre-creates a pending transaction when the investor submits EFT proof.
            // Updating it (not inserting) avoids a UNIQUE constraint violation on `reference`.
            let pendingTxn = null;
            try {
              const existing = await API._fetch('GET', `tables/transactions?investor_id=${encodeURIComponent(tkt.investor_id)}&reference=${encodeURIComponent(ref)}`);
              pendingTxn = (existing?.data ?? []).find(t => t.reference === ref && t.type === 'deposit') || null;
            } catch (_) {}

            if (pendingTxn) {
              await API._fetch('PATCH', `tables/transactions/${pendingTxn.id}`, {
                status:      'completed',
                amount:      amount,
                description: `EFT wallet top-up approved by admin. Ref: ${ref}`,
              });
            } else {
              await API.transactions.create({
                id:          Utils.genId('TXN'),
                investor_id: tkt.investor_id,
                type:        'deposit',
                amount:      amount,
                status:      'completed',
                description: `EFT wallet top-up approved by admin. Ref: ${ref}`,
                reference:   ref,
              });
            }
            // Safeguard: reconcile the investor's wallet balance from completed
            // transactions. The PATCH/POST hooks credit the wallet synchronously,
            // but a transient DB error between the two queries can leave the
            // transaction marked completed while the wallet_balance is unchanged.
            // Reconcile is a no-op if the balance is already correct.
            await API._fetch('POST', 'admin/reconcile-wallet', { investor_id: tkt.investor_id }).catch(() => {});
          }
          await API.tickets.update(id, {
            status:         'resolved',
            admin_response: document.getElementById('ticketResponse').value ||
              (approve ? `Your EFT deposit of R${amount?.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} has been approved and credited to your wallet.`
                       : 'Your EFT proof of payment was declined. Please resubmit with a clear, complete proof of payment.'),
            responded_at:   new Date().toISOString(),
          });
          Toast.success(approve ? `R${amount?.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} credited to wallet — ticket resolved` : 'Declined — investor will be notified');
          Modal.close('ticketModal');
          await Promise.all([loadSupport(), loadInvestors()]);
        } catch (e) { Toast.error('Action failed: ' + (e.message || 'Unknown error')); }
        return;
      }

      confirmMsg = approve
        ? (isBankVerification ? 'Approve this bank account? The investor will be notified.' : 'Approve FICA documents? The investor will be marked as KYC-verified.')
        : (isBankVerification ? 'Decline this bank account? The investor will be asked to resubmit.' : 'Decline these documents? The investor will be asked to resubmit.');
      if (!await Confirm.ask(approve ? 'Confirm Approval' : 'Confirm Decline', { body: confirmMsg, confirmLabel: approve ? 'Approve' : 'Decline', danger: !approve })) return;
      try {
        invUpdate = isBankVerification
          ? (approve ? { bank_account_status: 'approved' } : { bank_account_status: 'rejected' })
          : (approve
              ? { kyc_status: 'approved', fica_status: 'approved', status: 'active' }
              : { kyc_status: 'rejected', fica_status: 'rejected' });
        await API.investors.update(tkt.investor_id, invUpdate);
        await API.tickets.update(id, {
          status:         'resolved',
          admin_response: document.getElementById('ticketResponse').value || (approve ? 'Your submission has been approved.' : 'Your submission was declined. Please resubmit with correct details.'),
          responded_at:   new Date().toISOString(),
        });
        Toast.success(approve ? 'Approved — investor record updated and ticket resolved' : 'Declined — investor will be asked to resubmit');
        Modal.close('ticketModal');
        await loadSupport();
        await loadInvestors();
      } catch (e) { Toast.error('Action failed: ' + (e.message || 'Unknown error')); }
    };
    document.getElementById('ticketApproveBtn')?.addEventListener('click', () => _doTicketAction(true));
    document.getElementById('ticketDeclineBtn')?.addEventListener('click', () => _doTicketAction(false));
  }

  document.getElementById('ticketSaveBtn').onclick = async () => {
    try {
      const newStatus   = document.getElementById('ticketStatusUpdate').value;
      const newAssigned = document.getElementById('ticketAssigned').value;
      await API.tickets.update(id, {
        admin_response: document.getElementById('ticketResponse').value,
        status:         newStatus,
        assigned_to:    newAssigned,
        responded_at:   new Date().toISOString(),
      });
      Toast.success('Response saved — investor will see this in their portal');
      if (newAssigned && newAssigned !== tkt.assigned_to) {
        Toast.info('Assignment notification sent');
      }
      Modal.close('ticketModal');
      await loadSupport();
    } catch (e) { Toast.error('Failed to update ticket'); }
  };

  Modal.open('ticketModal');

  // Inline FICA/KYC documents preview
  if (isFicaSubmission && tkt.investor_id) {
    const docsEl = document.getElementById('kycDocsPreviewBody');
    if (docsEl) {
      try {
        const res = await API.kyc.list({ investor_id: tkt.investor_id, limit: 100 });
        const docs = (res.data || []).sort((a, b) =>
          new Date(b.submitted_at || b.created_at || 0) - new Date(a.submitted_at || a.created_at || 0));
        if (!docs.length) {
          docsEl.innerHTML = '<span style="color:var(--text-muted)"><i class="fa-solid fa-file-slash" style="margin-right:6px"></i>No KYC documents found for this investor.</span>';
        } else {
          const DOC_LABELS = {
            id: 'ID Document', id_document: 'ID Document', passport: 'Passport',
            proof_of_address: 'Proof of Address', address: 'Proof of Address',
            selfie: 'Selfie / Live Photo', tax: 'Tax Certificate (SARS)',
            proof_of_bank: 'Proof of Bank Account', other: 'Other Document',
          };
          docsEl.innerHTML = `<div style="display:grid;gap:10px;padding-bottom:4px">${docs.map((doc, idx) => {
            const src   = doc.file_data || doc.attachment_data || doc.file_url || '';
            const label = DOC_LABELS[doc.doc_type] || (doc.doc_type || 'Document').replace(/_/g, ' ');
            const fname = doc.file_name || label;
            const dkey  = `tkc_${tkt.id}_${idx}`;
            _ticketDocCache[dkey] = src || null;
            const isImg = src && (src.startsWith('data:image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(src));
            const djson = JSON.stringify(dkey);
            const fjson = JSON.stringify(fname);
            const idjson = JSON.stringify(doc.id);
            const hasFile = !!(src || doc.file_name);
            return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <i class="fa-solid fa-file-${isImg ? 'image' : 'lines'}" style="color:#eda5ff;font-size:1.05rem;flex-shrink:0"></i>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:700;font-size:0.84rem;color:var(--text)">${_esc(label)}</div>
                  ${doc.submitted_at || doc.created_at ? `<div style="font-size:0.72rem;color:var(--text-muted)">${Utils.date(doc.submitted_at || doc.created_at)}</div>` : ''}
                </div>
                ${src
                  ? `<button class="btn btn--secondary btn--sm" onclick="_openTicketDoc(${djson},${fjson})"><i class="fa-solid fa-eye"></i> View</button>
                     <button class="btn btn--ghost btn--sm" onclick="_downloadTicketDoc(${djson},${fjson})"><i class="fa-solid fa-download"></i> Download</button>`
                  : hasFile
                    ? `<button class="btn btn--secondary btn--sm" onclick="viewFicaDocument(${idjson})"><i class="fa-solid fa-eye"></i> View</button>`
                    : `<span style="font-size:0.75rem;color:var(--text-muted);font-style:italic">No file</span>`}
              </div>
              ${src && isImg ? `<div style="margin-top:8px"><img src="${src}" alt="${_esc(fname)}" style="max-width:100%;max-height:220px;object-fit:contain;border-radius:4px;display:block"></div>` : ''}
            </div>`;
          }).join('')}</div>`;
        }
      } catch (e) {
        const el2 = document.getElementById('kycDocsPreviewBody');
        if (el2) el2.innerHTML = `<span style="color:#ef4444"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px"></i>Could not load documents: ${_esc(e.message || 'unknown error')}</span>`;
      }
    }
  }

  // Inline proof-of-bank preview
  if (isBankVerification && tkt.investor_id) {
    const previewEl = document.getElementById('bankProofPreview');
    if (previewEl) {
      try {
        const res = await API.kyc.list({ investor_id: tkt.investor_id, limit: 200 });
        const proofs = (res.data || [])
          .filter(d => d.doc_type === 'proof_of_bank')
          .sort((a, b) => new Date(b.submitted_at || b.created_at || 0) - new Date(a.submitted_at || a.created_at || 0));
        if (!proofs.length) {
          previewEl.innerHTML = '<span style="color:var(--text-muted)"><i class="fa-solid fa-file-slash" style="margin-right:6px"></i>No document uploaded yet.</span>';
        } else {
          const doc = proofs[0];
          const src = doc.file_data || doc.attachment_data || doc.file_url || '';
          const name = doc.file_name || 'Proof of Bank';
          if (!src) {
            previewEl.innerHTML = `<span style="color:var(--text-muted)"><i class="fa-solid fa-file-slash" style="margin-right:6px"></i>Document on file has no viewable data.</span>`;
          } else if (src.startsWith('data:image/') || src.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
            previewEl.innerHTML = `<img src="${src}" alt="${_esc(name)}" style="max-width:100%;border-radius:6px;display:block">`;
          } else {
            const blob = _dataUrlToBlob(src);
            const blobUrl = blob ? URL.createObjectURL(blob) : src;
            previewEl.innerHTML = `<iframe src="${blobUrl}" style="width:100%;height:520px;border:none;border-radius:6px" title="${_esc(name)}"></iframe>
              <div style="margin-top:6px;text-align:right"><a href="${blobUrl}" target="_blank" rel="noopener" style="font-size:0.78rem;color:#eda5ff"><i class="fa-solid fa-arrow-up-right-from-square" style="margin-right:4px"></i>Open full screen</a></div>`;
          }
        }
      } catch (e) {
        const previewEl2 = document.getElementById('bankProofPreview');
        if (previewEl2) previewEl2.innerHTML = `<span style="color:#ef4444"><i class="fa-solid fa-triangle-exclamation" style="margin-right:6px"></i>Could not load document: ${_esc(e.message || 'unknown error')}</span>`;
      }
    }
  }
}

/* ═══════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════ */
async function loadAnalytics() {
  try {
    if (!STATE.investors.length || !STATE.investments.length) {
      const [invRes, invstRes, txnRes] = await Promise.all([
        API.investors.list({ limit: 5000 }),
        API.investments.list({ limit: 5000 }),
        API.transactions.list({ limit: 5000 })
      ]);
      STATE.investors = invRes.data || [];
      STATE.investments = invstRes.data || [];
      STATE.transactions = txnRes.data || [];
    }

    const now = Date.now();
    const thirtyDays = 30 * 86400000;
    const newInvestors = STATE.investors.filter(i => now - new Date(i.date_joined) < thirtyDays).length;
    const referred = STATE.investors.filter(i => i.referred_by).length;
    document.getElementById('an-monthlynew').textContent = newInvestors;
    document.getElementById('an-referrals').textContent = referred;

    // Live analytics stat cards
    const cattlePools = STATE.pools.filter(p => (p.product_type || '').toLowerCase().includes('cattle') && p.annual_rate > 0);
    const avgCattleRate = cattlePools.length
      ? (cattlePools.reduce((s, p) => s + (parseFloat(p.annual_rate) || 0), 0) / cattlePools.length * 100).toFixed(2) + '%'
      : '—';
    const lowestMin = STATE.pools.filter(p => p.status === 'open' && p.min_investment > 0)
      .reduce((min, p) => Math.min(min, parseFloat(p.min_investment) || Infinity), Infinity);

    const cattleEl = document.getElementById('an-cattle-return');
    if (cattleEl) cattleEl.textContent = avgCattleRate;
    const minEl = document.querySelectorAll('#view-analytics .stat-card__value')[1];
    if (minEl && minEl.textContent === 'R500') minEl.textContent = lowestMin < Infinity ? Utils.rand(lowestMin, 0) : 'R500';

    renderProductVolChart();
    renderProvinceChart();
    renderRiskChart();
    renderTxnFlowChart();
    renderConversionFunnel();
    _renderAnalyticsCharts();
    loadInvestFunnel();
    loadSignupFriction();
    renderMaturityForecastChart();
    renderCohortChart();
    renderMobileActivity();
    loadPersonas();
  } catch (e) {
    Toast.error('Failed to load analytics data');
    console.error('[loadAnalytics]', e);
  }
}

/* ── Investor Personas ──────────────────────────────────── */
async function loadPersonas() {
  const panel = document.getElementById('personasPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="text-center text-muted" style="padding:20px">Loading…</div>';
  try {
    const res = await fetch('/api/analytics/personas', { headers: { Authorization: `Bearer ${AUTH.token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    _renderPersonas(data);
  } catch (e) {
    panel.innerHTML = `<div class="text-center text-muted" style="padding:20px">No persona data yet — investors complete profile quests to appear here.</div>`;
    console.warn('[personas]', e.message);
  }
}

function _renderPersonas(data) {
  const panel = document.getElementById('personasPanel');
  if (!panel) return;

  const PERSONA_META = {
    'Conservative Saver': { icon: 'fa-shield-halved', color: '#64748b', desc: 'Prioritises capital preservation. Low risk tolerance, cautious approach.' },
    'Growth Seeker':      { icon: 'fa-chart-line',    color: '#22c55e', desc: 'Focused on long-term capital growth. Comfortable with volatility.' },
    'Income Investor':    { icon: 'fa-coins',          color: '#fec24f', desc: 'Wants regular income from investments. Dividend / returns oriented.' },
    'Risk Taker':         { icon: 'fa-fire-flame-curved', color: '#ef4444', desc: 'Experienced investor who buys on dips. High conviction, high risk.' },
    'Long-Term Planner':  { icon: 'fa-calendar-days', color: '#eda5ff', desc: 'Investing for retirement or dependents. Steady, multi-year horizon.' },
    'Explorer':           { icon: 'fa-compass',        color: '#fec24f', desc: 'Just getting started. Goals and risk profile still taking shape.' },
  };

  const total = data.total || 1;

  // Archetype cards
  const archetypeHtml = Object.entries(data.personaCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const m = PERSONA_META[name] || PERSONA_META['Explorer'];
      const pct = Math.round(count / total * 100);
      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:36px;height:36px;border-radius:50%;background:${m.color}22;display:flex;align-items:center;justify-content:center">
              <i class="fa-solid ${m.icon}" style="color:${m.color};font-size:15px"></i>
            </div>
            <div>
              <div style="font-weight:600;font-size:0.9rem">${name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted)">${count} investor${count !== 1 ? 's' : ''} · ${pct}%</div>
            </div>
          </div>
          <div style="height:4px;background:var(--border);border-radius:2px">
            <div style="height:4px;width:${pct}%;background:${m.color};border-radius:2px"></div>
          </div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${m.desc}</div>
        </div>`;
    }).join('');

  // Distribution chart helper
  const distChart = (title, obj) => {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    const max = entries[0][1];
    return `
      <div style="margin-bottom:16px">
        <div style="font-weight:600;font-size:0.82rem;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">${title}</div>
        ${entries.map(([label, count]) => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
            <div style="flex:0 0 160px;font-size:0.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
            <div style="flex:1;height:6px;background:var(--border);border-radius:3px">
              <div style="height:6px;width:${Math.round(count/max*100)}%;background:var(--orange);border-radius:3px"></div>
            </div>
            <div style="flex:0 0 24px;font-size:0.78rem;color:var(--text-muted);text-align:right">${count}</div>
          </div>`).join('')}
      </div>`;
  };

  const dist = data.distributions || {};

  // Investor table (most recent 20)
  const tableRows = (data.investors || []).slice(0, 20).map(inv => {
    const m = PERSONA_META[inv.persona] || PERSONA_META['Explorer'];
    return `
      <tr>
        <td style="font-weight:500">${inv.name || '—'}</td>
        <td style="color:var(--text-muted);font-size:0.8rem">${inv.email || '—'}</td>
        <td>
          <span style="display:inline-flex;align-items:center;gap:5px;background:${m.color}22;color:${m.color};padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600">
            <i class="fa-solid ${m.icon}" style="font-size:10px"></i>${inv.persona}
          </span>
        </td>
        <td style="color:var(--text-muted);font-size:0.8rem">${inv.profile?.investment_goal || inv.profile?.saving_for || '—'}</td>
        <td style="color:var(--text-muted);font-size:0.8rem">${inv.profile?.time_horizon || '—'}</td>
        <td style="color:var(--text-muted);font-size:0.8rem">${inv.profile?.income_bracket || '—'}</td>
        <td><span style="background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:2px 8px;font-size:0.75rem">${inv.level || '—'} · ${inv.xp || 0} XP</span></td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    <!-- Total badge -->
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <span style="font-size:1.5rem;font-weight:700">${total}</span>
      <span style="color:var(--text-muted)">investors with profile survey data</span>
    </div>

    <!-- Archetype cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:24px">
      ${archetypeHtml || '<div class="text-muted">No persona data yet.</div>'}
    </div>

    <!-- Distributions -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
      <div class="panel" style="padding:16px">
        ${distChart('Investment Goal', dist.investment_goal)}
        ${distChart('Time Horizon', dist.time_horizon)}
        ${distChart('Saving For', dist.saving_for)}
      </div>
      <div class="panel" style="padding:16px">
        ${distChart('Employment Status', dist.employment_status)}
        ${distChart('Income Bracket', dist.income_bracket)}
        ${distChart('Investment Experience', dist.investment_experience)}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px">
      <div class="panel" style="padding:16px">
        ${distChart('Risk Reaction', dist.risk_reaction)}
        ${distChart('Dependents', dist.dependents)}
      </div>
      <div class="panel" style="padding:16px">
        ${distChart('Referred Via', dist.heard_via)}
      </div>
    </div>

    <!-- Investor table -->
    <div style="font-weight:600;font-size:0.85rem;margin-bottom:10px">Individual Profiles (most recent 20)</div>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          <th>Name</th><th>Email</th><th>Persona</th><th>Goal</th><th>Horizon</th><th>Income</th><th>Level</th>
        </tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="text-center text-muted">No survey data yet</td></tr>'}</tbody>
      </table>
    </div>`;
}

function renderMaturityForecastChart() {
  const ctx = document.getElementById('maturityForecastChart');
  if (!ctx) return;
  const now = new Date();
  const months = [], amounts = [];
  for (let m = 0; m < 6; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() + m + 1, 1);
    months.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
    amounts.push(STATE.investments.filter(i => {
      if (!i.end_date || !['active','matured'].includes(i.status)) return false;
      const ed = new Date(i.end_date);
      return ed.getFullYear() === d.getFullYear() && ed.getMonth() === d.getMonth();
    }).reduce((s, i) => s + (parseFloat(i.amount) || 0), 0));
  }
  if (STATE.charts.maturityForecast) STATE.charts.maturityForecast.destroy();
  STATE.charts.maturityForecast = new Chart(ctx, {
    type: 'bar',
    data: { labels: months, datasets: [{ label: 'Capital Maturing (R)', data: amounts, backgroundColor: 'rgba(254,194,79,0.7)', borderColor: '#fec24f', borderWidth: 1, borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a92a8', font: { size: 11 } } }, tooltip: { callbacks: { label: c => ` ${Utils.rand(c.parsed.y)}` } } },
      scales: { x: { ticks: { color: '#3d5268' }, grid: { display: false } }, y: { ticks: { color: '#3d5268', callback: v => 'R'+(v/1000).toFixed(0)+'k' }, grid: { color: 'rgba(0,0,0,0.05)' } } }
    }
  });
}

function renderCohortChart() {
  const ctx = document.getElementById('cohortChart');
  if (!ctx) return;
  const now = new Date();
  const months = [], counts = [];
  for (let m = 11; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    months.push(d.toLocaleString('default', { month: 'short', year: '2-digit' }));
    counts.push(STATE.investors.filter(i => {
      if (!i.date_joined) return false;
      const jd = new Date(i.date_joined);
      return jd.getFullYear() === d.getFullYear() && jd.getMonth() === d.getMonth();
    }).length);
  }
  if (STATE.charts.cohort) STATE.charts.cohort.destroy();
  STATE.charts.cohort = new Chart(ctx, {
    type: 'bar',
    data: { labels: months, datasets: [{ label: 'New Investors', data: counts, backgroundColor: 'rgba(101,101,101,0.7)', borderColor: '#656565', borderWidth: 1, borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a92a8', font: { size: 11 } } } },
      scales: { x: { ticks: { color: '#3d5268' }, grid: { display: false } }, y: { ticks: { color: '#3d5268', stepSize: 1 }, grid: { color: 'rgba(0,0,0,0.05)' } } }
    }
  });
}

async function renderMobileActivity() {
  const panel = document.getElementById('mobileActivityPanel');
  if (!panel) return;

  panel.innerHTML = '<div class="text-center text-muted" style="padding:20px">Loading mobile activity…</div>';

  // Query audit_events filtered by platform
  const now = new Date();
  const thirtyDays = new Date(now - 30 * 86400000).toISOString();

  let iosEvents = [], androidEvents = [], webEvents = [];
  try {
    const [iosRes, androidRes, webRes] = await Promise.all([
      API._fetch('GET', 'tables/audit_events', null, { platform: 'ios',     limit: 1000, date_from: thirtyDays }),
      API._fetch('GET', 'tables/audit_events', null, { platform: 'android', limit: 1000, date_from: thirtyDays }),
      API._fetch('GET', 'tables/audit_events', null, { platform: 'web',     limit: 1000, date_from: thirtyDays }),
    ]);
    iosEvents     = iosRes.data     || [];
    androidEvents = androidRes.data || [];
    webEvents     = webRes.data     || [];
  } catch (_) {
    // platform column may not exist — fall back to full audit events and classify by description
    try {
      const res = await API._fetch('GET', 'tables/audit_events', null, { limit: 2000, date_from: thirtyDays });
      const all = res.data || [];
      iosEvents     = all.filter(e => (e.platform || e.device_type || e.user_agent || '').toLowerCase().includes('ios'));
      androidEvents = all.filter(e => (e.platform || e.device_type || e.user_agent || '').toLowerCase().includes('android'));
      webEvents     = all.filter(e => !iosEvents.includes(e) && !androidEvents.includes(e));
    } catch (_2) {}
  }

  const iosLogins  = iosEvents.filter(e => (e.event_type || '').includes('login')).length;
  const droidLogins= androidEvents.filter(e => (e.event_type || '').includes('login')).length;
  const webLogins  = webEvents.filter(e => (e.event_type || '').includes('login')).length;
  const totalLogins= iosLogins + droidLogins + webLogins;

  // Build recent mobile events list (iOS + Android combined)
  const recentMobile = [...iosEvents, ...androidEvents]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  const pct = (n) => totalLogins ? Math.round(n / totalLogins * 100) : 0;

  panel.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px">
      <div style="background:rgba(101,101,101,0.08);border:1px solid rgba(0,150,255,0.2);border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <i class="fa-brands fa-apple" style="font-size:1.2rem;color:#656565"></i>
          <span style="font-size:0.72rem;font-weight:700;color:#656565;text-transform:uppercase;letter-spacing:0.05em">iOS</span>
        </div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--text)">${iosEvents.length.toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">events (30d)</div>
        <div style="margin-top:8px;height:4px;background:rgba(0,0,0,0.1);border-radius:2px">
          <div style="height:100%;width:${pct(iosLogins)}%;background:#656565;border-radius:2px"></div>
        </div>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:4px">${iosLogins} logins · ${pct(iosLogins)}% of total</div>
      </div>
      <div style="background:rgba(61,220,132,0.08);border:1px solid rgba(61,220,132,0.2);border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <i class="fa-brands fa-android" style="font-size:1.2rem;color:#3ddc84"></i>
          <span style="font-size:0.72rem;font-weight:700;color:#3ddc84;text-transform:uppercase;letter-spacing:0.05em">Android</span>
        </div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--text)">${androidEvents.length.toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">events (30d)</div>
        <div style="margin-top:8px;height:4px;background:rgba(0,0,0,0.1);border-radius:2px">
          <div style="height:100%;width:${pct(droidLogins)}%;background:#3ddc84;border-radius:2px"></div>
        </div>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:4px">${droidLogins} logins · ${pct(droidLogins)}% of total</div>
      </div>
      <div style="background:rgba(254,194,79,0.07);border:1px solid rgba(254,194,79,0.15);border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <i class="fa-solid fa-globe" style="font-size:1.1rem;color:var(--gold)"></i>
          <span style="font-size:0.72rem;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:0.05em">Web</span>
        </div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--text)">${webEvents.length.toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">events (30d)</div>
        <div style="margin-top:8px;height:4px;background:rgba(0,0,0,0.1);border-radius:2px">
          <div style="height:100%;width:${pct(webLogins)}%;background:var(--gold);border-radius:2px"></div>
        </div>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:4px">${webLogins} logins · ${pct(webLogins)}% of total</div>
      </div>
      <div style="background:rgba(237,165,255,0.08);border:1px solid rgba(237,165,255,0.2);border-radius:10px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <i class="fa-solid fa-mobile-screen" style="font-size:1.1rem;color:#eda5ff"></i>
          <span style="font-size:0.72rem;font-weight:700;color:#eda5ff;text-transform:uppercase;letter-spacing:0.05em">App Total</span>
        </div>
        <div style="font-size:1.6rem;font-weight:800;color:var(--text)">${(iosEvents.length + androidEvents.length).toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">iOS + Android (30d)</div>
        <div style="margin-top:8px;height:4px;background:rgba(0,0,0,0.1);border-radius:2px">
          <div style="height:100%;width:${totalLogins ? Math.round((iosLogins + droidLogins) / totalLogins * 100) : 0}%;background:#eda5ff;border-radius:2px"></div>
        </div>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:4px">${iosLogins + droidLogins} app logins · ${totalLogins ? Math.round((iosLogins + droidLogins) / totalLogins * 100) : 0}% share</div>
      </div>
    </div>

    ${recentMobile.length ? `
    <div>
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Recent Mobile Activity</div>
      <div style="display:flex;flex-direction:column;gap:0">
        ${recentMobile.map(e => {
          const isPlatformIos = (e.platform || e.device_type || e.user_agent || '').toLowerCase().includes('ios');
          const icon  = isPlatformIos ? 'fa-apple' : 'fa-android';
          const color = isPlatformIos ? '#656565' : '#3ddc84';
          const plat  = isPlatformIos ? 'iOS' : 'Android';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(${isPlatformIos?'0,150,255':'61,220,132'},0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i class="fa-brands ${icon}" style="font-size:0.82rem;color:${color}"></i>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.78rem;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.user_email || e.actor || '—'}</div>
              <div style="font-size:0.7rem;color:var(--text-muted)">${e.event_type || e.action || '—'} · ${plat}</div>
            </div>
            <div style="font-size:0.68rem;color:var(--text-dim);flex-shrink:0">${Utils.date(e.created_at)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : `<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:0.82rem">
      <i class="fa-solid fa-mobile-screen" style="font-size:1.5rem;margin-bottom:8px;display:block;opacity:0.3"></i>
      No mobile app events in the last 30 days. Platform activity will appear here once investors use the iOS or Android app.
    </div>`}
  `;
}

function renderProductVolChart() {
  const ctx = document.getElementById('productVolChart');
  if (!ctx) return;
  const vol = {};
  STATE.investments.forEach(i => { vol[i.product_type] = (vol[i.product_type] || 0) + i.amount; });
  const labels = Object.keys(vol).map(k => Utils.productInfo(k).label);
  const data = Object.values(vol);
  const colors = ['#fec24f', '#22c55e', '#4ade80', '#86efac', '#656565', '#f97316'];

  if (STATE.charts.productVol) STATE.charts.productVol.destroy();
  STATE.charts.productVol = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Volume (R)', data, backgroundColor: colors, borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${Utils.rand(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#3d5268', font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', callback: v => 'R' + (v / 1000).toFixed(0) + 'k' } }
      }
    }
  });
}

const _PROVINCE_NORM = {
  // Gauteng
  'gp':'Gauteng','gauteng':'Gauteng','gauteng province':'Gauteng','guateng':'Gauteng','gaunteng':'Gauteng','gautrng':'Gauteng','gauteng province':'Gauteng',
  // Western Cape
  'wc':'Western Cape','western cape':'Western Cape','western cape province':'Western Cape','westerncape':'Western Cape','wetern cape':'Western Cape',
  // Eastern Cape
  'ec':'Eastern Cape','eastern cape':'Eastern Cape','eastern cape province':'Western Cape','easterncape':'Eastern Cape',
  // KwaZulu-Natal
  'kzn':'KwaZulu-Natal','kwazulu-natal':'KwaZulu-Natal','kwazulu natal':'KwaZulu-Natal','kwa-zulu natal':'KwaZulu-Natal','kwa zulu natal':'KwaZulu-Natal','kwazulunatal':'KwaZulu-Natal','natal':'KwaZulu-Natal','kwa-zulu nata':'KwaZulu-Natal',
  // Limpopo
  'lp':'Limpopo','limpopo':'Limpopo','limpopo province':'Limpopo',
  // Mpumalanga
  'mp':'Mpumalanga','mpumalanga':'Mpumalanga','mpumalanga province':'Mpumalanga',
  // Northern Cape
  'nc':'Northern Cape','northern cape':'Northern Cape','northern cape province':'Northern Cape','northerncape':'Northern Cape','nothern cape':'Northern Cape',
  // North West
  'nw':'North West','north west':'North West','north west province':'North West','northwest':'North West','north-west':'North West','north west':'North West','northwestprovince':'North West',
  // Free State
  'fs':'Free State','free state':'Free State','free state province':'Free State','freestate':'Free State',
};
function _normProvince(raw) {
  if (!raw) return null;
  return _PROVINCE_NORM[raw.trim().toLowerCase()] || raw.trim() || null;
}

function renderProvinceChart() {
  const ctx = document.getElementById('provinceChart');
  if (!ctx) return;
  const prov = {};
  STATE.investors.forEach(i => {
    const p = _normProvince(i.province);
    if (!p) return;
    prov[p] = (prov[p] || 0) + 1;
  });
  const PROVINCE_COLORS = {
    'Gauteng':       '#fec24f',
    'KwaZulu-Natal': '#22c55e',
    'Western Cape':  '#eda5ff',
    'Eastern Cape':  '#f97316',
    'Limpopo':       '#84cc16',
    'Mpumalanga':    '#38bdf8',
    'North West':    '#a78bfa',
    'Free State':    '#fb923c',
    'Northern Cape': '#94a3b8',
  };
  const labels = Object.keys(prov);
  const colors = labels.map(l => PROVINCE_COLORS[l] || '#656565');

  if (STATE.charts.province) STATE.charts.province.destroy();
  STATE.charts.province = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data: labels.map(l => prov[l]), backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 8 } } }
    }
  });
}

function renderRiskChart() {
  const ctx = document.getElementById('riskChart');
  if (!ctx) return;
  const risk = { conservative: 0, moderate: 0, aggressive: 0 };
  STATE.investors.forEach(i => { if (risk[i.risk_profile] !== undefined) risk[i.risk_profile]++; });

  if (STATE.charts.risk) STATE.charts.risk.destroy();
  STATE.charts.risk = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Conservative', 'Moderate', 'Aggressive'],
      datasets: [{ data: Object.values(risk), backgroundColor: ['#22c55e', '#fec24f', '#ef4444'], borderColor: 'var(--dark-2)', borderWidth: 3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } } }
    }
  });
}

function renderTxnFlowChart() {
  const ctx = document.getElementById('txnFlowChart');
  if (!ctx) return;

  // Build last 6 calendar months from real transaction data
  const now = new Date();
  const monthStarts = [], months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthStarts.push(d);
    months.push(d.toLocaleString('en-ZA', { month: 'short' }));
  }
  const _inMonth = (dateStr, start) => {
    const d = new Date(dateStr || 0);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59);
    return d >= start && d <= end;
  };
  const deposits = monthStarts.map(m =>
    STATE.transactions.filter(t => t.type === 'deposit' && t.status === 'completed' && _inMonth(t.created_at || t.transaction_date, m))
      .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0)
  );
  const payouts = monthStarts.map(m =>
    STATE.transactions.filter(t => (t.type === 'return' || t.type === 'payout') && t.status === 'completed' && _inMonth(t.created_at || t.transaction_date, m))
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0)
  );

  if (STATE.charts.txnFlow) STATE.charts.txnFlow.destroy();
  STATE.charts.txnFlow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        { label: 'Deposits', data: deposits, backgroundColor: 'rgba(34,197,94,0.6)', borderRadius: 4 },
        { label: 'Payouts', data: payouts, backgroundColor: 'rgba(254,194,79,0.6)', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${Utils.rand(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#3d5268', font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', callback: v => 'R' + (v / 1000).toFixed(0) + 'k' } }
      }
    }
  });
}

function renderConversionFunnel() {
  const panel = document.getElementById('funnelPanel');
  if (!panel) return;

  const investors    = STATE.investors   || [];
  const transactions = STATE.transactions || [];
  const investments  = STATE.investments  || [];
  const total = investors.length;
  if (!total) { panel.innerHTML = '<div class="text-center text-muted" style="padding:20px">No investor data</div>'; return; }

  /* ── Stage counts ────────────────────────────────── */
  const ficaSubmitted = investors.filter(i =>
    ['fica_submitted', 'active'].includes(i.status) ||
    ['fica_submitted', 'approved'].includes(i.fica_status)
  ).length;

  const ficaApproved = investors.filter(i =>
    i.status === 'active' || i.fica_status === 'approved'
  ).length;

  const depositedIds = new Set(
    transactions
      .filter(t => t.type === 'deposit' && t.status === 'completed' && t.investor_id != null)
      .map(t => t.investor_id)
  );
  const deposited = investors.filter(i => i.id != null && depositedIds.has(i.id)).length;

  // Investors grouped by investment count
  const invCountById = {};
  investments.filter(inv => inv.investor_id != null).forEach(inv => {
    invCountById[inv.investor_id] = (invCountById[inv.investor_id] || 0) + 1;
  });
  const investedIds  = new Set(Object.keys(invCountById));
  const invested     = investors.filter(i => i.id != null && investedIds.has(i.id)).length;
  const multiInvested = investors.filter(i => i.id != null && (invCountById[i.id] || 0) >= 2).length;

  const recurringIds = new Set(
    investors.filter(i => i.recurring_enabled).map(i => i.id)
  );
  const recurring = recurringIds.size;

  // Investors who generated a referral bonus for someone else
  const referrerIds = new Set(
    transactions
      .filter(t => t.type === 'referral_bonus' && t.investor_id != null)
      .map(t => t.investor_id)
  );
  const referred = referrerIds.size;

  const stages = [
    { label: 'Signed Up',          count: total,         color: '#656565', icon: '✍️' },
    { label: 'FICA Submitted',      count: ficaSubmitted,  color: '#656565', icon: '📋' },
    { label: 'FICA Approved',       count: ficaApproved,   color: '#fec24f', icon: '✅' },
    { label: 'First Deposit',       count: deposited,      color: '#22c55e', icon: '💳' },
    { label: 'First Investment',    count: invested,       color: '#fec24f', icon: '📈' },
    { label: 'Repeat Investor',     count: multiInvested,  color: '#f97316', icon: '🔄' },
    { label: 'Recurring Set',       count: recurring,      color: '#eda5ff', icon: '⚡' },
    { label: 'Referred Someone',    count: referred,       color: '#ec4899', icon: '🎁' },
  ];

  /* ── AUM metrics — computed from live investments table ───────────── */
  const totalAUM  = investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const activeAUM = investments.filter(i => i.status === 'active' && i.investor_id != null && investedIds.has(i.investor_id)).reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

  // Average first investment amount
  const firstInvByInvestor = {};
  investments
    .filter(inv => inv.investor_id != null && inv.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .forEach(inv => {
      if (!firstInvByInvestor[inv.investor_id]) {
        firstInvByInvestor[inv.investor_id] = parseFloat(inv.amount) || 0;
      }
    });
  const firstInvAmts = Object.values(firstInvByInvestor);
  const avgFirstInv  = firstInvAmts.length
    ? firstInvAmts.reduce((s, v) => s + v, 0) / firstInvAmts.length
    : 0;

  // Avg days signup → first investment
  const daysToInvest = [];
  investors.forEach(inv => {
    if (!inv.id || !inv.created_at || !invCountById[inv.id]) return;
    const firstInvDate = investments
      .filter(i => i.investor_id === inv.id && i.created_at)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]?.created_at;
    if (firstInvDate) {
      const days = (new Date(firstInvDate) - new Date(inv.created_at)) / 86400000;
      if (days >= 0 && days < 3650) daysToInvest.push(days);
    }
  });
  const avgDays = daysToInvest.length
    ? Math.round(daysToInvest.reduce((s, v) => s + v, 0) / daysToInvest.length)
    : null;

  // Most popular product type for first investment
  const firstInvProducts = {};
  Object.keys(firstInvByInvestor).forEach(invId => {
    const inv = investments
      .filter(i => i.investor_id === invId && i.created_at)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    if (inv?.product_type) {
      firstInvProducts[inv.product_type] = (firstInvProducts[inv.product_type] || 0) + 1;
    }
  });
  const topProduct = Object.keys(firstInvProducts).sort((a, b) => firstInvProducts[b] - firstInvProducts[a])[0] || '—';

  const fmt = n => 'R' + Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

  /* ── Render ─────────────────────────────────────── */
  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0">
      ${stages.map((s, i) => {
        const pct     = total > 0 ? Math.round(s.count / total * 100) : 0;
        const dropOff = i > 0 ? Math.round((1 - s.count / (stages[i-1].count || 1)) * 100) : 0;
        const dropColor = dropOff > 50 ? '#ef4444' : dropOff > 25 ? '#f97316' : '#fec24f';
        return `
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <div style="display:flex;align-items:center;gap:7px">
                <span style="font-size:0.8rem">${s.icon}</span>
                <span style="font-size:0.81rem;font-weight:600;color:var(--text)">${s.label}</span>
                ${i > 0 && dropOff > 0 ? `<span style="font-size:0.68rem;color:${dropColor};background:${dropColor}22;padding:1px 6px;border-radius:4px">−${dropOff}% drop</span>` : ''}
              </div>
              <div style="display:flex;gap:10px;align-items:center">
                <span style="font-size:0.88rem;font-weight:700;color:var(--text)">${s.count.toLocaleString()}</span>
                <span style="font-size:0.75rem;color:var(--text-muted);min-width:34px;text-align:right">${pct}%</span>
              </div>
            </div>
            <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${s.color};border-radius:3px;transition:width 0.7s ease"></div>
            </div>
          </div>`;
      }).join('')}
    </div>

    <!-- Summary metrics -->
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
      <div style="background:rgba(254,194,79,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">End-to-end</div>
        <div style="font-size:1.1rem;font-weight:700;color:#fec24f">${invested > 0 ? Math.round(invested/total*100) : 0}%</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">conversion rate</div>
      </div>
      <div style="background:rgba(34,197,94,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Total AUM</div>
        <div style="font-size:1.05rem;font-weight:700;color:#22c55e">${fmt(totalAUM)}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">all investors</div>
      </div>
      <div style="background:rgba(237,165,255,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Avg 1st Invest</div>
        <div style="font-size:1.05rem;font-weight:700;color:#656565">${avgFirstInv > 0 ? fmt(avgFirstInv) : '—'}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">per investor</div>
      </div>
      <div style="background:rgba(59,130,246,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Avg days to invest</div>
        <div style="font-size:1.05rem;font-weight:700;color:#656565">${avgDays !== null ? avgDays + 'd' : '—'}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">signup → 1st investment</div>
      </div>
      <div style="background:rgba(249,115,22,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Top pool</div>
        <div style="font-size:0.88rem;font-weight:700;color:#f97316;text-transform:capitalize">${topProduct.replace(/_/g,' ')}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">1st investment choice</div>
      </div>
      <div style="background:rgba(237,165,255,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Retention</div>
        <div style="font-size:1.05rem;font-weight:700;color:#eda5ff">${invested > 0 ? Math.round(multiInvested/invested*100) : 0}%</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">made 2+ investments</div>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
   SIGNUP FRICTION ANALYSIS
   ═══════════════════════════════════════════════ */
async function loadInvestFunnel() {
  const panel = document.getElementById('investFunnelPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="text-center text-muted" style="padding:20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  try {
    const days = document.getElementById('investFunnelDaysFilter')?.value || 30;
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res = await fetch(`/api/analytics/invest-funnel/summary?days=${days}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderInvestFunnel(data, panel);
  } catch (err) {
    panel.innerHTML = '<div class="text-center text-muted" style="padding:20px">No funnel data yet — it will appear once investors use the marketplace.</div>';
  }
}

function renderInvestFunnel(data, panel) {
  const { funnel = {}, conversion_rate = 0, fee_aversion_rate = 0,
          abandoned_breakdown = {}, insufficient_funds = [],
          topup_cancelled = 0, by_product = [], daily_trend = [], by_pool = [] } = data;

  const { opened = 0, fee_shown = 0, confirmed = 0, abandoned = 0 } = funnel;

  function pct(n, d) { return d > 0 ? Math.round(n / d * 100) : 0; }
  function dropBadge(drop) {
    if (!drop) return '';
    const col = drop >= 40 ? '#ef4444' : drop >= 20 ? '#f97316' : '#fec24f';
    return `<span style="font-size:0.68rem;color:${col};background:${col}18;padding:2px 6px;border-radius:4px;margin-left:8px">−${drop}% drop</span>`;
  }

  const steps = [
    { label: 'Modal opened',  val: opened,    prev: null,    color: '#eda5ff' },
    { label: 'Fee breakdown seen', val: fee_shown, prev: opened,  color: '#fec24f' },
    { label: 'Confirmed',     val: confirmed, prev: fee_shown, color: '#22c55e' },
    { label: 'Abandoned',     val: abandoned, prev: opened,  color: '#ef4444' },
  ];
  const maxVal = Math.max(...steps.map(s => s.val), 1);

  const funnelHtml = steps.map(s => {
    const barPct = Math.round(s.val / maxVal * 100);
    const drop   = s.prev != null && s.prev > 0 ? Math.round((1 - s.val / s.prev) * 100) : 0;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
        <div style="width:130px;font-size:0.78rem;font-weight:600;color:var(--text);flex-shrink:0">${s.label}</div>
        <div style="flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${barPct}%;background:${s.color};border-radius:4px;transition:width 0.6s ease"></div>
        </div>
        <div style="width:44px;text-align:right;font-size:0.82rem;font-weight:700;color:var(--text)">${s.val.toLocaleString()}</div>
        <div style="width:80px">${s.prev != null && drop > 0 ? dropBadge(drop) : ''}</div>
      </div>`;
  }).join('');

  const abFeeAversion = fee_aversion_rate > 0 ? `${Math.round(fee_aversion_rate * 100)}%` : '—';
  const insufAtOpen   = (insufficient_funds.find(r => r.stage === 'modal_open')?.count   || 0).toLocaleString();
  const insufAtAmount = (insufficient_funds.find(r => r.stage === 'amount_entry')?.count || 0).toLocaleString();

  const productHtml = by_product.length
    ? by_product.map(r => {
        const conv = r.opened > 0 ? Math.round(r.confirmed / r.opened * 100) : 0;
        const col  = conv >= 60 ? '#22c55e' : conv >= 30 ? '#fec24f' : '#ef4444';
        return `<tr>
          <td style="padding:6px 8px;font-size:0.78rem;color:var(--text)">${r.product_type || '—'}</td>
          <td style="padding:6px 8px;font-size:0.78rem;text-align:right">${r.opened.toLocaleString()}</td>
          <td style="padding:6px 8px;font-size:0.78rem;text-align:right">${r.confirmed.toLocaleString()}</td>
          <td style="padding:6px 8px;font-size:0.78rem;font-weight:700;color:${col};text-align:right">${conv}%</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" style="padding:12px;font-size:0.78rem;color:var(--text-muted);text-align:center">No data yet</td></tr>';

  panel.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px">
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#eda5ff">${opened.toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Modals opened</div>
      </div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#22c55e">${Math.round(conversion_rate * 100)}%</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Open → Confirmed</div>
      </div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#ef4444">${abFeeAversion}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Fee-aversion rate</div>
      </div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;text-align:center">
        <div style="font-size:1.5rem;font-weight:800;color:#f97316">${topup_cancelled.toLocaleString()}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Top-up cancelled</div>
      </div>
    </div>

    <div style="margin-bottom:18px">
      <div style="font-size:0.8rem;font-weight:700;color:var(--text);margin-bottom:8px">Invest modal funnel</div>
      ${funnelHtml}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
      <div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--text);margin-bottom:8px">Abandoned: why they left</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:7px 10px;background:rgba(239,68,68,0.07);border-radius:8px">
            <span style="color:var(--text)">Saw fee, still left</span>
            <strong style="color:#ef4444">${(abandoned_breakdown.fee_seen || 0).toLocaleString()}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:7px 10px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px">
            <span style="color:var(--text)">Left before entering amount</span>
            <strong style="color:#6b7280">${(abandoned_breakdown.no_fee_seen || 0).toLocaleString()}</strong>
          </div>
        </div>
      </div>
      <div>
        <div style="font-size:0.8rem;font-weight:700;color:var(--text);margin-bottom:8px">Insufficient funds wall</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:7px 10px;background:rgba(249,115,22,0.07);border-radius:8px">
            <span style="color:var(--text)">Wallet too low at modal open</span>
            <strong style="color:#f97316">${insufAtOpen}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:7px 10px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px">
            <span style="color:var(--text)">Typed more than wallet holds</span>
            <strong style="color:#f97316">${insufAtAmount}</strong>
          </div>
        </div>
      </div>
    </div>

    <div>
      <div style="font-size:0.8rem;font-weight:700;color:var(--text);margin-bottom:8px">Conversion by product</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid var(--border)">
              <th style="padding:6px 8px;font-size:0.72rem;text-align:left;color:var(--text-muted)">Product</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Opened</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Confirmed</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Conv %</th>
            </tr>
          </thead>
          <tbody>${productHtml}</tbody>
        </table>
      </div>
    </div>

    ${by_pool.length ? `
    <div style="margin-top:18px">
      <div style="font-size:0.8rem;font-weight:700;color:var(--text);margin-bottom:8px">Drop-off by pool</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid var(--border)">
              <th style="padding:6px 8px;font-size:0.72rem;text-align:left;color:var(--text-muted)">Pool</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Opened</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Fee seen</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Confirmed</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Abandoned</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Conv %</th>
              <th style="padding:6px 8px;font-size:0.72rem;text-align:right;color:var(--text-muted)">Drop %</th>
            </tr>
          </thead>
          <tbody>
            ${by_pool.map(r => {
              const conv     = r.opened > 0 ? Math.round(r.confirmed / r.opened * 100) : 0;
              const dropRate = r.opened > 0 ? Math.round(r.abandoned / r.opened * 100) : 0;
              const convCol  = conv >= 60 ? '#22c55e' : conv >= 30 ? '#fec24f' : '#ef4444';
              const dropCol  = dropRate >= 60 ? '#ef4444' : dropRate >= 30 ? '#f97316' : '#fec24f';
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:6px 8px;font-size:0.78rem;color:var(--text);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.pool_name}">${r.pool_name}</td>
                <td style="padding:6px 8px;font-size:0.78rem;text-align:right;color:var(--text-muted)">${r.opened.toLocaleString()}</td>
                <td style="padding:6px 8px;font-size:0.78rem;text-align:right;color:var(--text-muted)">${r.fee_shown.toLocaleString()}</td>
                <td style="padding:6px 8px;font-size:0.78rem;text-align:right;color:var(--text-muted)">${r.confirmed.toLocaleString()}</td>
                <td style="padding:6px 8px;font-size:0.78rem;text-align:right;color:var(--text-muted)">${r.abandoned.toLocaleString()}</td>
                <td style="padding:6px 8px;font-size:0.78rem;font-weight:700;color:${convCol};text-align:right">${conv}%</td>
                <td style="padding:6px 8px;font-size:0.78rem;font-weight:700;color:${dropCol};text-align:right">${dropRate}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
`;
}

async function loadSignupFriction() {
  const panel = document.getElementById('frictionPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="text-center text-muted" style="padding:20px"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';

  try {
    const days = document.getElementById('frictionDaysFilter')?.value || 30;
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res = await fetch(`/api/analytics/signup-friction/summary?days=${days}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderSignupFriction(data, panel);
  } catch (err) {
    panel.innerHTML = `<div class="text-center text-muted" style="padding:20px">No friction data yet — it will appear once users visit the signup page.</div>`;
  }
}

function renderSignupFriction(data, panel) {
  const { total_sessions = 0, completion_rate = 0, step_funnel = [],
          top_errors = [], top_error_fields = [], avg_time_per_step = [],
          device_breakdown = [], client_type_breakdown = [] } = data;

  const stepByNum = {};
  step_funnel.forEach(s => { stepByNum[s.step] = s.sessions; });
  const maxSessions = Math.max(...step_funnel.map(s => s.sessions), 1);

  const stepNames = { 1: 'Personal Info', 2: 'Security', 3: 'Profile', 4: 'FICA Docs' };
  const stepColors = { 1: '#656565', 2: '#656565', 3: '#fec24f', 4: '#22c55e' };

  function fmtMs(ms) {
    if (!ms) return '—';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  // Build step funnel rows
  const funnelHtml = [1, 2, 3, 4].map(step => {
    const sessions = stepByNum[step] || 0;
    const prev     = stepByNum[step - 1] || sessions;
    const pct      = maxSessions > 0 ? Math.round(sessions / maxSessions * 100) : 0;
    const dropOff  = step > 1 && prev > 0 ? Math.round((1 - sessions / prev) * 100) : 0;
    const dropColor = dropOff >= 40 ? '#ef4444' : dropOff >= 20 ? '#f97316' : '#fec24f';
    const timeRow  = avg_time_per_step.find(t => t.step === step);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
        <div style="width:90px;font-size:0.78rem;font-weight:600;color:var(--text);flex-shrink:0">
          <span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${stepColors[step]};color:#fff;font-size:0.65rem;font-weight:700;text-align:center;line-height:20px;margin-right:5px">${step}</span>${stepNames[step]}
        </div>
        <div style="flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${stepColors[step]};border-radius:4px;transition:width 0.6s ease"></div>
        </div>
        <div style="width:40px;text-align:right;font-size:0.82rem;font-weight:700;color:var(--text)">${sessions.toLocaleString()}</div>
        ${step > 1 && dropOff > 0
          ? `<div style="width:66px;font-size:0.68rem;color:${dropColor};background:${dropColor}18;padding:2px 6px;border-radius:4px;text-align:center">−${dropOff}% drop</div>`
          : '<div style="width:66px"></div>'}
        <div style="width:52px;font-size:0.68rem;color:var(--text-muted);text-align:right">${timeRow ? 'avg ' + fmtMs(timeRow.avg_ms) : ''}</div>
      </div>`;
  }).join('');

  // Top errors table
  const errHtml = top_errors.length
    ? top_errors.slice(0, 6).map(e => `
        <tr>
          <td style="padding:6px 8px;font-size:0.75rem;color:var(--text-muted);white-space:nowrap">Step ${e.step}</td>
          <td style="padding:6px 8px;font-size:0.75rem;color:var(--text);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.error_message}">${e.error_message}</td>
          <td style="padding:6px 8px;font-size:0.75rem;font-weight:700;color:#ef4444;text-align:right">${e.count}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" style="padding:12px;font-size:0.78rem;color:var(--text-muted);text-align:center">No errors recorded yet</td></tr>';

  // Top friction fields
  const fieldHtml = top_error_fields.length
    ? top_error_fields.slice(0, 6).map(f => `
        <tr>
          <td style="padding:6px 8px;font-size:0.75rem;color:var(--text-muted);white-space:nowrap">Step ${f.step}</td>
          <td style="padding:6px 8px;font-size:0.75rem;font-weight:600;color:var(--text)">${f.field_name}</td>
          <td style="padding:6px 8px;font-size:0.75rem;font-weight:700;color:#f97316;text-align:right">${f.count}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" style="padding:12px;font-size:0.78rem;color:var(--text-muted);text-align:center">No field data yet</td></tr>';

  // Device chart
  const totalDev = device_breakdown.reduce((s, d) => s + d.count, 0) || 1;
  const devHtml = device_breakdown.map(d => {
    const pct = Math.round(d.count / totalDev * 100);
    const colors = { mobile: '#eda5ff', desktop: '#656565', tablet: '#22c55e' };
    const c = colors[d.device_type] || '#6b7280';
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="width:62px;font-size:0.75rem;color:var(--text-muted);text-transform:capitalize">${d.device_type}</div>
      <div style="flex:1;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${c};border-radius:3px"></div>
      </div>
      <div style="width:32px;text-align:right;font-size:0.75rem;font-weight:600;color:var(--text)">${pct}%</div>
    </div>`;
  }).join('');

  const completionPct = Math.round(parseFloat(completion_rate) * 100);
  const biggestDropStep = [1, 2, 3, 4].reduce((worst, step) => {
    if (step === 1) return worst;
    const curr = stepByNum[step] || 0;
    const prev = stepByNum[step - 1] || curr;
    const drop = prev > 0 ? Math.round((1 - curr / prev) * 100) : 0;
    return drop > (worst.drop || 0) ? { step, drop } : worst;
  }, {});

  panel.innerHTML = `
    <!-- Metric cards -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px">
      <div style="background:rgba(237,165,255,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Total Sessions</div>
        <div style="font-size:1.3rem;font-weight:800;color:#656565">${total_sessions.toLocaleString()}</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">signup page visits</div>
      </div>
      <div style="background:rgba(34,197,94,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Completion Rate</div>
        <div style="font-size:1.3rem;font-weight:800;color:#22c55e">${completionPct}%</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">reached submit</div>
      </div>
      ${biggestDropStep.step ? `
      <div style="background:rgba(239,68,68,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Biggest Drop-Off</div>
        <div style="font-size:1.3rem;font-weight:800;color:#ef4444">Step ${biggestDropStep.step}</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">${biggestDropStep.drop}% don't proceed</div>
      </div>` : ''}
      <div style="background:rgba(255,130,21,0.08);border-radius:8px;padding:10px 12px">
        <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px">Top Error</div>
        <div style="font-size:0.82rem;font-weight:700;color:#f97316;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px">${top_errors[0]?.error_message?.slice(0, 40) || '—'}</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">${top_errors[0] ? top_errors[0].count + ' occurrences' : 'no errors yet'}</div>
      </div>
    </div>

    <!-- Step funnel -->
    <div style="margin-bottom:16px">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Step-by-Step Drop-Off</div>
      ${funnelHtml}
    </div>

    <!-- Bottom two-column layout -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <!-- Left: top errors -->
      <div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Most Common Validation Errors</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Step</th>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Error</th>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">#</th>
          </tr></thead>
          <tbody>${errHtml}</tbody>
        </table>
      </div>

      <!-- Right: field friction + device -->
      <div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Most Friction — Fields</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <thead><tr>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Step</th>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Field</th>
            <th style="font-size:0.65rem;color:var(--text-muted);text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">#</th>
          </tr></thead>
          <tbody>${fieldHtml}</tbody>
        </table>

        <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Device Breakdown</div>
        ${devHtml || '<div style="font-size:0.78rem;color:var(--text-muted)">No device data yet</div>'}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════ */
/* ─── Terms of Use Editor ─── */
async function loadTermsEditor() {
  const ta = document.getElementById('termsEditor');
  const lastEl = document.getElementById('termsLastUpdated');
  if (!ta) return;
  ta.value = 'Loading…';
  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/terms-content', { credentials: 'include' });
    const data = await res.json();
    ta.value = data.content || '';
    if (lastEl) lastEl.textContent = data.content ? 'Custom content loaded' : 'Using default content (not yet saved)';
  } catch (_) {
    ta.value = '';
    if (lastEl) lastEl.textContent = 'Failed to load — server error';
  }
}

async function saveTermsContent() {
  const ta = document.getElementById('termsEditor');
  if (!ta || !ta.value.trim()) return Toast.error('Content cannot be empty');
  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/terms-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: ta.value.trim() })
    });
    if (!res.ok) throw new Error();
    Toast.success('Terms of Use saved successfully');
    const lastEl = document.getElementById('termsLastUpdated');
    if (lastEl) lastEl.textContent = 'Saved ' + new Date().toLocaleString('en-ZA');
  } catch (_) {
    Toast.error('Failed to save terms — please try again');
  }
}

/* ─── Privacy Policy / POPIA Editor ─── */
async function loadPrivacyEditor() {
  const ta = document.getElementById('privacyEditor');
  const lastEl = document.getElementById('privacyLastUpdated');
  if (!ta) return;
  ta.value = 'Loading…';
  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/privacy-content', { credentials: 'include' });
    const data = await res.json();
    ta.value = data.content || '';
    if (lastEl) {
      if (data.updatedAt) {
        lastEl.textContent = 'Last saved: ' + new Date(data.updatedAt).toLocaleString('en-ZA');
      } else {
        lastEl.textContent = 'Using default content (not yet saved)';
      }
    }
  } catch (_) {
    ta.value = '';
    if (lastEl) lastEl.textContent = 'Failed to load — server error';
  }
}

async function savePrivacyContent() {
  const ta = document.getElementById('privacyEditor');
  if (!ta || !ta.value.trim()) return Toast.error('Content cannot be empty');
  try {
    const res = await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/privacy-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: ta.value.trim() })
    });
    if (!res.ok) throw new Error();
    Toast.success('Privacy Policy saved successfully');
    const lastEl = document.getElementById('privacyLastUpdated');
    if (lastEl) lastEl.textContent = 'Saved ' + new Date().toLocaleString('en-ZA');
  } catch (_) {
    Toast.error('Failed to save privacy policy — please try again');
  }
}

async function resetPrivacyToDefault() {
  if (!await Confirm.ask('Reset Privacy Policy to default?', {
    body: 'This will clear any custom content saved in the database.',
    confirmLabel: 'Reset', danger: true
  })) return;
  try {
    await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/privacy-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: '' })
    });
    const ta = document.getElementById('privacyEditor');
    if (ta) ta.value = '';
    Toast.success('Privacy Policy reset to default');
  } catch (_) {
    Toast.error('Failed to reset privacy policy');
  }
}

async function resetTermsToDefault() {
  if (!await Confirm.ask('Reset Terms & Conditions to default?', {
    body: 'This will clear any custom content saved in the database.',
    confirmLabel: 'Reset', danger: true
  })) return;
  try {
    await fetch((window.__SVC_API_BASE__ || '/api/') + 'legal/terms-content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: '' })
    });
    const ta = document.getElementById('termsEditor');
    if (ta) ta.value = '';
    Toast.success('Terms reset to default');
  } catch (_) {
    Toast.error('Failed to reset terms');
  }
}

function renderSettings() {
  const body = document.getElementById('settingsBody');
  if (!STATE.settings.length) {
    body.innerHTML = '<div class="text-center text-muted" style="padding:32px">No settings found</div>';
    return;
  }
  // platform_settings uses `key` as PK (not `id`) and `description` (not `label`)
  body.innerHTML = STATE.settings.map(s => `
    <div class="form-group">
      <label class="form-label">${s.key ? s.key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'}</label>
      <input type="text" class="form-input" data-setting-id="${s.key}" value="${_esc(s.value || '')}" />
      ${s.description ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${_esc(s.description)}</div>` : ''}
    </div>
  `).join('');
}

async function saveSettings() {
  const inputs = document.querySelectorAll('[data-setting-id]');
  const updates = [];
  inputs.forEach(inp => updates.push(API.settings.update(inp.dataset.settingId, { value: inp.value })));
  try {
    await Promise.all(updates);
    Toast.success('Settings saved successfully');
  } catch (e) { Toast.error('Failed to save settings'); }
}

/* ─── 2FA / Account Security ─── */
let _tfa2FASecret = null; // holds pending secret during setup

async function loadSettings() {
  try {
    const res = await API.settings.list();
    STATE.settings = res.data || [];
    renderSettings();
    await tfa_loadStatus(); // load 2FA status alongside platform settings
  } catch (e) { Toast.error('Failed to load settings'); }
}

async function tfa_loadStatus() {
  try {
    const res = await fetch('/api/auth/2fa/status', { credentials: 'include' });
    const { enabled } = await res.json();
    const badge = document.getElementById('tfa-status-badge');
    const enableBtn = document.getElementById('tfa-enable-btn');
    const disableBtn = document.getElementById('tfa-disable-btn');
    if (badge) {
      badge.textContent = enabled ? '✓ Enabled' : '✗ Not enabled';
      badge.style.background = enabled ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.12)';
      badge.style.color = enabled ? '#22c55e' : '#ef4444';
    }
    if (enableBtn) enableBtn.style.display = enabled ? 'none' : '';
    if (disableBtn) disableBtn.style.display = enabled ? '' : 'none';
    tfaCancelSetup();
    tfaCancelDisable();
  } catch (e) { console.error('[tfa_loadStatus]', e); }
}

async function tfaStartSetup() {
  try {
    const res = await fetch('/api/auth/2fa/setup', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error((await res.json()).error || 'Setup failed');
    const { secret, uri } = await res.json();
    _tfa2FASecret = secret;
    // render QR
    const container = document.getElementById('tfa-qr-container');
    if (container) {
      container.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(container, { text: uri, width: 164, height: 164, correctLevel: QRCode.CorrectLevel.M });
      } else {
        container.innerHTML = '<div style="font-size:0.72rem;color:#7a92a8;padding:10px">QR library not loaded — use the key below</div>';
      }
    }
    const keyEl = document.getElementById('tfa-manual-key');
    if (keyEl) keyEl.textContent = secret.match(/.{1,4}/g).join(' ');
    document.getElementById('tfa-step-0').style.display = 'none';
    document.getElementById('tfa-step-1').style.display = '';
    document.getElementById('tfa-step-2').style.display = 'none';
    document.getElementById('tfa-code-input').value = '';
    setTimeout(() => document.getElementById('tfa-code-input')?.focus(), 100);
  } catch (e) { Toast.error('Failed to start setup: ' + e.message); }
}

function tfaCancelSetup() {
  _tfa2FASecret = null;
  const s0 = document.getElementById('tfa-step-0');
  const s1 = document.getElementById('tfa-step-1');
  const s2 = document.getElementById('tfa-step-2');
  if (s0) s0.style.display = '';
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = 'none';
}

async function tfaVerifyEnable() {
  const code = (document.getElementById('tfa-code-input')?.value || '').replace(/\s/g, '');
  if (code.length !== 6) { Toast.error('Enter the 6-digit code from your authenticator app'); return; }
  if (!_tfa2FASecret) { Toast.error('Setup session expired — please start again'); tfaCancelSetup(); return; }
  try {
    const res = await fetch('/api/auth/2fa/enable', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: _tfa2FASecret, token: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    // Show recovery codes
    const codesEl = document.getElementById('tfa-recovery-codes');
    if (codesEl) {
      codesEl.innerHTML = (data.recoveryCodes || []).map(c =>
        `<div style="background:rgba(0,0,0,.2);border-radius:4px;padding:4px 6px;text-align:center">${c}</div>`
      ).join('');
    }
    document.getElementById('tfa-step-0').style.display = 'none';
    document.getElementById('tfa-step-1').style.display = 'none';
    document.getElementById('tfa-step-2').style.display = '';
    Toast.success('2FA enabled successfully');
    await tfa_loadStatus();
  } catch (e) { Toast.error(e.message || 'Invalid code — try again'); }
}

function tfaDoneSetup() {
  _tfa2FASecret = null;
  tfaCancelSetup();
  tfa_loadStatus();
}

function tfaShowDisable() {
  document.getElementById('tfa-step-0').style.display = 'none';
  document.getElementById('tfa-step-disable').style.display = '';
  document.getElementById('tfa-step-1').style.display = 'none';
  document.getElementById('tfa-step-2').style.display = 'none';
  setTimeout(() => document.getElementById('tfa-disable-code')?.focus(), 100);
}

function tfaCancelDisable() {
  const el = document.getElementById('tfa-step-disable');
  const s0 = document.getElementById('tfa-step-0');
  if (el) el.style.display = 'none';
  if (s0) s0.style.display = '';
}

async function tfaConfirmDisable() {
  const code = (document.getElementById('tfa-disable-code')?.value || '').replace(/\s/g, '');
  if (code.length !== 6) { Toast.error('Enter the 6-digit code from your authenticator app'); return; }
  try {
    const res = await fetch('/api/auth/2fa/disable', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    Toast.success('2FA disabled');
    tfaCancelDisable();
    await tfa_loadStatus();
  } catch (e) { Toast.error(e.message || 'Invalid code'); }
}

async function adminReset2FA(userId, investorName, btn) {
  if (!await Confirm.ask(`Reset 2FA for ${investorName}?`, {
    body: 'This will disable two-factor authentication on their account. They will be able to log in with password only until they re-enable it.',
    confirmLabel: 'Reset 2FA',
  })) return;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/admin/reset-2fa', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    Toast.success(`2FA removed from ${investorName}'s account`);
    if (btn) { btn.disabled = false; btn.style.display = 'none'; }
  } catch (e) {
    Toast.error('Reset failed: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

async function signOutAllDevices() {
  if (!await Confirm.ask('Sign out all devices?', {
    body: 'This will immediately invalidate all active sessions on every device. You will need to log in again.',
    confirmLabel: 'Sign Out All',
  })) return;
  try {
    const res = await fetch('/api/auth/signout-all', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    Toast.success('All sessions revoked — redirecting to login…');
    setTimeout(() => { window.location.href = '/login.html'; }, 1500);
  } catch (e) { Toast.error('Failed: ' + e.message); }
}

/* ═══════════════════════════════════════════════
   IFA MANAGEMENT
   ═══════════════════════════════════════════════ */
async function loadIFAs() {
  try {
    const [ifaRes, invRes] = await Promise.all([
      API.ifas.list({ limit: 100 }),
      API.investors.list({ limit: 200 })
    ]);
    STATE.ifas = ifaRes.data || [];
    if (invRes.data) STATE.investors = invRes.data;
    renderIFAStats();
    renderIFATable();
    setupIFASearch();
  } catch (e) {
    console.error('loadIFAs error:', e);
    Toast.error('Failed to load IFA data');
  }
}

function renderIFAStats() {
  const ifas = STATE.ifas;
  const active  = ifas.filter(f => f.status === 'active').length;
  const clients = ifas.reduce((s, f) => s + ((f.assigned_clients || []).length), 0);
  const aum     = ifas.reduce((s, f) => s + (f.aum_managed || 0), 0);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ifa-total',   ifas.length);
  set('ifa-active',  active);
  set('ifa-clients', clients);
  set('ifa-aum',     Utils.rand(aum));
  const fc = document.getElementById('ifaCount');
  if (fc) fc.textContent = `${ifas.length} IFA${ifas.length !== 1 ? 's' : ''} registered on platform`;
}

function renderIFATable(filterStatus = '', searchQ = '') {
  const tbody = document.getElementById('ifaBody');
  if (!tbody) return;

  let data = STATE.ifas.slice();
  if (filterStatus) data = data.filter(f => f.status === filterStatus);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(f =>
      (f.first_name || '').toLowerCase().includes(q) ||
      (f.last_name  || '').toLowerCase().includes(q) ||
      (f.company_name || '').toLowerCase().includes(q) ||
      (f.license_number || '').toLowerCase().includes(q) ||
      (f.email || '').toLowerCase().includes(q)
    );
  }

  const footer = document.getElementById('ifaFooterText');
  if (footer) footer.textContent = `Showing ${data.length} of ${STATE.ifas.length} IFAs`;

  if (!data.length) {
    tbody.innerHTML = data.length < STATE.ifas.length
      ? _emptyRow('fa-filter-circle-xmark', 'No matching IFAs', 'Try adjusting the search above.', 9)
      : _emptyRow('fa-handshake', 'No IFAs yet', 'Create the first IFA partner using the Add IFA button above.', 9);
    return;
  }

  tbody.innerHTML = data.map(ifa => {
    const clientCount = (ifa.assigned_clients || []).length;
    const statusColor = ifa.status === 'active' ? 'badge--green' : ifa.status === 'suspended' ? 'badge--red' : 'badge--gray';
    const initials = ((ifa.first_name || '')[0] || '') + ((ifa.last_name || '')[0] || '');
    return `<tr>
      <td>
        <div class="flex-center gap-10">
          <div class="avatar avatar--sm avatar--gold">${initials.toUpperCase()}</div>
          <div>
            <div class="td-strong clip">${ifa.first_name} ${ifa.last_name}</div>
            <div class="td-muted clip" style="font-size:0.72rem">${ifa.email}</div>
          </div>
        </div>
      </td>
      <td class="td-strong clip">${ifa.company_name || '—'}</td>
      <td><span class="clip" style="font-family:monospace;font-size:0.78rem;color:var(--text-muted)">${ifa.license_number || '—'}</span></td>
      <td>
        <span class="badge badge--blue" style="cursor:pointer" onclick="viewIFA('${ifa.id}')">
          <i class="fa-solid fa-users"></i> ${clientCount} client${clientCount !== 1 ? 's' : ''}
        </span>
      </td>
      <td class="td-gold fw-700">${Utils.rand(ifa.aum_managed || 0)}</td>
      <td class="td-muted">${Number(ifa.commission_rate || 0).toFixed(2)}%</td>
      <td><span class="badge ${statusColor}">${ifa.status || 'unknown'}</span></td>
      <td class="td-muted">${Utils.date(ifa.date_joined)}</td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--secondary btn--xs" onclick="viewIFA('${ifa.id}')" title="View Details"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn--primary btn--xs" onclick="openLinkClientModal('${ifa.id}')" title="Link Client"><i class="fa-solid fa-user-plus"></i></button>
          <button class="btn btn--danger btn--xs" onclick="deleteIFA('${ifa.id}')" title="Remove IFA"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function setupIFASearch() {
  const searchEl = document.getElementById('ifaSearch');
  const filterEl = document.getElementById('ifaStatusFilter');
  const getVals  = () => ({ q: searchEl?.value.trim() || '', f: filterEl?.value || '' });

  const refresh = () => {
    const { q, f } = getVals();
    renderIFATable(f, q);
  };

  if (searchEl && !searchEl._ifaWired) {
    searchEl.addEventListener('input', Utils.debounce(refresh, 220));
    searchEl._ifaWired = true;
  }
  if (filterEl && !filterEl._ifaWired) {
    filterEl.addEventListener('change', refresh);
    filterEl._ifaWired = true;
  }
}

function viewIFA(ifaId) {
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const clientIds = ifa.assigned_clients || [];
  const clients   = STATE.investors.filter(inv => clientIds.includes(inv.id));
  const initials  = ((ifa.first_name || '')[0] || '') + ((ifa.last_name || '')[0] || '');
  const statusColor = ifa.status === 'active' ? '#22c55e' : ifa.status === 'suspended' ? '#ef4444' : '#7a92a8';

  document.getElementById('ifaDetailTitle').textContent = `${ifa.first_name} ${ifa.last_name} — ${ifa.id}`;

  document.getElementById('ifaDetailBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="flex-center gap-12 mb-16">
          <div class="avatar avatar--lg avatar--gold">${initials.toUpperCase()}</div>
          <div>
            <div style="font-size:1.1rem;font-weight:800;color:var(--text)">${_esc(ifa.first_name)} ${_esc(ifa.last_name)}</div>
            <div style="color:var(--ci-text-muted,#6b7280);font-size:0.8rem">${_esc(ifa.email)}</div>
            <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px">${_esc(ifa.company_name) || ''}</div>
            <div class="mt-6"><span class="badge" style="background:${statusColor}20;color:${statusColor}">${_esc(ifa.status)}</span></div>
          </div>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Phone</span><span class="info-row__value">${_esc(ifa.phone) || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">FSP License</span><span class="info-row__value td-gold">${_esc(ifa.license_number) || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Commission Rate</span><span class="info-row__value">${Number(ifa.commission_rate || 0).toFixed(2)}%</span></div>
          <div class="info-row"><span class="info-row__label">Date Joined</span><span class="info-row__value">${Utils.date(ifa.date_joined)}</span></div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel__header"><span class="panel__title">Performance Summary</span></div>
          <div class="panel__body">
            <div class="info-list">
              <div class="info-row"><span class="info-row__label">Total Clients</span><span class="info-row__value text-gold">${clients.length}</span></div>
              <div class="info-row"><span class="info-row__label">AUM Managed</span><span class="info-row__value">${Utils.rand(ifa.aum_managed || 0)}</span></div>
              <div class="info-row"><span class="info-row__label">Total Client Invested</span><span class="info-row__value text-green">${Utils.rand(clients.reduce((s, c) => s + (c.total_invested || 0), 0))}</span></div>
              <div class="info-row"><span class="info-row__label">Total Client Wallet</span><span class="info-row__value">${Utils.rand(clients.reduce((s, c) => s + (c.wallet_balance || 0), 0))}</span></div>
            </div>
          </div>
        </div>
        ${ifa.notes ? `
        <div class="panel mt-12">
          <div class="panel__header"><span class="panel__title">Admin Notes</span></div>
          <div class="panel__body" style="font-size:0.82rem">${ifa.notes}</div>
        </div>` : ''}
      </div>
    </div>

    <div class="flex-between mb-12" style="align-items:center">
      <div style="font-size:0.85rem;font-weight:700;color:var(--text)">Linked Clients (${clients.length})</div>
      <button class="btn btn--primary btn--sm" onclick="openLinkClientModal('${ifa.id}');Modal.close('ifaDetailModal')">
        <i class="fa-solid fa-user-plus"></i> Link Client
      </button>
    </div>

    ${
      clients.length
      ? `<table class="data-table mb-16">
          <thead><tr><th>Investor</th><th>Email</th><th>FICA</th><th>Wallet</th><th>Invested</th><th>Action</th></tr></thead>
          <tbody>${clients.map(c => `
            <tr>
              <td>
                <div class="flex-center gap-8">
                  <div class="avatar avatar--sm">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
                  <span class="td-strong">${_esc(c.first_name)} ${_esc(c.last_name)}</span>
                </div>
              </td>
              <td class="td-muted">${_esc(c.email)}</td>
              <td>${Utils.statusBadge(c.fica_status || c.status)}</td>
              <td class="td-gold fw-700">${Utils.rand(c.wallet_balance)}</td>
              <td class="td-green">${Utils.rand(c.total_invested)}</td>
              <td>
                <button class="btn btn--danger btn--xs" onclick="unlinkClient('${ifa.id}','${c.id}')" title="Unlink from IFA">
                  <i class="fa-solid fa-user-minus"></i>
                </button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      : `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:0.85rem">
          <i class="fa-solid fa-users" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:8px"></i>
          No clients linked to this IFA yet.
        </div>`
    }

    ${clients.length ? (() => {
      const rate = ifa.commission_rate || 0;
      const rows = clients.map(c => {
        const invested = c.total_invested || 0;
        const comm = invested * (rate / 100);
        return `<tr>
          <td class="td-strong">${_esc(c.first_name)} ${_esc(c.last_name)}</td>
          <td class="td-muted" style="font-size:0.78rem">${_esc(c.id)}</td>
          <td class="td-gold fw-700">${Utils.rand(invested)}</td>
          <td class="td-green fw-700">${Utils.rand(comm)}</td>
        </tr>`;
      });
      const totalComm = clients.reduce((s,c) => s + (c.total_invested||0) * (rate/100), 0);
      return `
    <div class="panel mt-16 mb-16">
      <div class="panel__header"><span class="panel__title"><i class="fa-solid fa-coins" style="color:var(--gold);margin-right:6px"></i>Commission Report</span><span style="font-size:0.75rem;color:var(--text-muted)">${rate}% rate</span></div>
      <div class="panel__body" style="padding:0">
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr><th>Client</th><th>ID</th><th>Total Invested</th><th>Commission</th></tr></thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div>
        <div style="display:flex;justify-content:space-between;padding:12px 16px;background:rgba(254,194,79,0.07);border-top:1px solid var(--border)">
          <span style="font-size:0.85rem;font-weight:700;color:var(--text)">Total Commission Owed</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--gold)">${Utils.rand(totalComm)}</span>
        </div>
      </div>
    </div>`;
    })() : ''}

    <div class="flex-between mt-16" style="flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px">
        <button class="btn btn--success btn--sm" onclick="toggleIFAStatus('${ifa.id}','${ifa.status}')">
          <i class="fa-solid fa-toggle-${ifa.status === 'active' ? 'off' : 'on'}"></i>
          ${ifa.status === 'active' ? 'Deactivate' : 'Activate'} IFA
        </button>
        <button class="btn btn--danger btn--sm" onclick="deleteIFA('${ifa.id}');Modal.close('ifaDetailModal')">
          <i class="fa-solid fa-trash"></i> Remove IFA
        </button>
      </div>
      <button class="btn btn--primary btn--sm" onclick="Modal.close('ifaDetailModal')">
        <i class="fa-solid fa-check"></i> Done
      </button>
    </div>
  `;

  Modal.open('ifaDetailModal');
}

function openAddIFAModal() {
  ['newIFAFirstName','newIFALastName','newIFAEmail','newIFAPhone','newIFALicense','newIFACompany','newIFANotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const commEl = document.getElementById('newIFACommission');
  if (commEl) commEl.value = '1.5';
  const statusEl = document.getElementById('newIFAStatus');
  if (statusEl) statusEl.value = 'active';
  Modal.open('addIFAModal');
}

async function saveNewIFA(btn) {
  const fn = document.getElementById('newIFAFirstName').value.trim();
  const ln = document.getElementById('newIFALastName').value.trim();
  const em = document.getElementById('newIFAEmail').value.trim();
  const lic = document.getElementById('newIFALicense').value.trim();
  if (!fn || !ln || !em || !lic) {
    Toast.error('First name, last name, email and license number are required');
    return;
  }

  const payload = {
    id: `IFA-${Date.now()}`,
    first_name: fn,
    last_name: ln,
    email: em,
    phone: document.getElementById('newIFAPhone').value.trim(),
    license_number: lic,
    company_name: document.getElementById('newIFACompany').value.trim(),
    commission_rate: parseFloat(document.getElementById('newIFACommission').value) || 1.0,
    status: document.getElementById('newIFAStatus').value,
    assigned_clients: [],
    aum_managed: 0,
    notes: document.getElementById('newIFANotes').value.trim(),
    date_joined: new Date().toISOString()
  };

  await _withBtn(btn, async () => {
    try {
      await API.ifas.create(payload);
      Toast.success(`IFA ${fn} ${ln} created successfully`);
      Modal.close('addIFAModal');
      await loadIFAs();
    } catch (e) {
      Toast.error('Failed to create IFA: ' + (e.message || 'unknown error'));
      console.error('[saveNewIFA]', e);
    }
  });
}

function openLinkClientModal(ifaId) {
  document.getElementById('linkClientIFAId').value = ifaId;
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  const linked = ifa ? (ifa.assigned_clients || []) : [];

  const unlinked = STATE.investors.filter(inv => !linked.includes(inv.id));
  const sel = document.getElementById('linkClientInvestorSelect');
  sel.innerHTML = '<option value="">— Choose investor —</option>' +
    unlinked.map(inv => `<option value="${inv.id}">${inv.first_name} ${inv.last_name} (${inv.email})</option>`).join('');

  Modal.open('linkClientModal');
}

async function confirmLinkClient() {
  const ifaId  = document.getElementById('linkClientIFAId').value;
  const invId  = document.getElementById('linkClientInvestorSelect').value;
  if (!ifaId || !invId) { Toast.error('Please select an investor'); return; }

  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const current = ifa.assigned_clients || [];
  if (current.includes(invId)) { Toast.info('Investor already linked to this IFA'); return; }

  const updated = [...current, invId];
  const inv = STATE.investors.find(i => i.id === invId);
  const invAUM = inv ? (inv.total_invested || 0) : 0;

  try {
    await API.ifas.update(ifaId, { assigned_clients: updated, aum_managed: (ifa.aum_managed || 0) + invAUM });
    Toast.success(`${inv ? inv.first_name + ' ' + inv.last_name : 'Investor'} linked to IFA`);
    Modal.close('linkClientModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to link client');
  }
}

async function unlinkClient(ifaId, investorId) {
  if (!await Confirm.ask('Unlink investor?', { body: 'This investor will no longer be associated with this IFA.', confirmLabel: 'Unlink' })) return;
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const updated = (ifa.assigned_clients || []).filter(id => id !== investorId);
  const inv = STATE.investors.find(i => i.id === investorId);
  const removedAUM = inv ? (inv.total_invested || 0) : 0;
  const newAUM = Math.max(0, (ifa.aum_managed || 0) - removedAUM);

  try {
    await API.ifas.update(ifaId, { assigned_clients: updated, aum_managed: newAUM });
    Toast.success('Client unlinked from IFA');
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to unlink client');
  }
}

async function toggleIFAStatus(ifaId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  const label = newStatus === 'active' ? 'activated' : 'deactivated';
  if (!await Confirm.ask(`${newStatus === 'active' ? 'Activate' : 'Deactivate'} IFA?`, { body: `This IFA will be ${newStatus === 'active' ? 'reactivated on the platform' : 'deactivated and unable to onboard new clients'}.`, confirmLabel: newStatus === 'active' ? 'Activate' : 'Deactivate', danger: newStatus !== 'active' })) return;

  try {
    await API.ifas.update(ifaId, { status: newStatus });
    Toast.success(`IFA ${label} successfully`);
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to update IFA status');
  }
}

async function deleteIFA(ifaId) {
  if (!await Confirm.ask('Remove IFA?', { body: 'This IFA will be permanently removed. This cannot be undone.', confirmLabel: 'Remove', danger: true })) return;
  try {
    await API.ifas.delete(ifaId);
    Toast.success('IFA removed from platform');
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to remove IFA');
  }
}

/* ═══════════════════════════════════════════════
   P3.1 — KYC DOCUMENT UPLOAD
   ═══════════════════════════════════════════════ */

/** Open the KYC upload modal, pre-selecting investor */
function openKycUploadModal(investorId, investorName) {
  const overlay = document.getElementById('kycUploadModal');
  if (!overlay) return;
  document.getElementById('kycUploadInvestorId').value   = investorId   || '';
  document.getElementById('kycUploadInvestorName').value = investorName || '';
  document.getElementById('kycUploadForm').reset();
  document.getElementById('kycUploadInvestorId').value   = investorId   || '';
  document.getElementById('kycUploadInvestorName').value = investorName || '';
  document.getElementById('kycUploadPreview').innerHTML  = '';
  document.getElementById('kycUploadStatus').textContent = '';
  document.getElementById('kycUploadDropLabel').textContent = 'Click or drag a file here';

  /* Investor search-as-you-type */
  const kycSearchInput = document.getElementById('kycInvSearchInput');
  const kycDropdown    = document.getElementById('kycInvDropdown');
  if (kycSearchInput && kycDropdown) {
    // Pre-fill when opened from a specific investor row
    if (investorId) {
      const pre = STATE.investors.find(i => i.id === investorId);
      const preName = pre ? `${pre.first_name || ''} ${pre.last_name || ''}`.trim() : (investorName || '');
      kycSearchInput.value = preName ? `${preName} (${investorId})` : investorId;
    } else {
      kycSearchInput.value = '';
    }
    kycDropdown.style.display = 'none';
    kycDropdown.innerHTML = '';

    function _kycRenderDropdown(q) {
      const term = q.trim().toLowerCase();
      if (!term) { kycDropdown.style.display = 'none'; return; }
      const matches = STATE.investors.filter(inv => {
        const name  = `${inv.first_name || ''} ${inv.last_name || ''}`.toLowerCase();
        const id    = (inv.id    || '').toLowerCase();
        const email = (inv.email || '').toLowerCase();
        return name.includes(term) || id.includes(term) || email.includes(term);
      }).slice(0, 25);
      if (!matches.length) { kycDropdown.style.display = 'none'; return; }
      kycDropdown.innerHTML = matches.map(inv => {
        const name = `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || '—';
        const emailLine = inv.email
          ? `<span style="color:var(--text-muted);font-size:0.77rem">${inv.email}</span>` : '';
        return `<li data-id="${inv.id}" data-name="${name}" style="padding:9px 14px;cursor:pointer;display:flex;flex-direction:column;gap:2px">
          <span style="font-weight:600;font-size:0.87rem">${name}
            <span style="color:var(--text-muted);font-weight:400;font-size:0.8rem">(${inv.id})</span>
          </span>
          ${emailLine}
        </li>`;
      }).join('');
      kycDropdown.style.display = 'block';
      kycDropdown.querySelectorAll('li').forEach(li => {
        li.onmouseenter = () => li.style.background = 'rgba(255,255,255,0.06)';
        li.onmouseleave = () => li.style.background = '';
        li.onclick = () => {
          document.getElementById('kycUploadInvestorId').value   = li.dataset.id;
          document.getElementById('kycUploadInvestorName').value = li.dataset.name;
          kycSearchInput.value = `${li.dataset.name} (${li.dataset.id})`;
          kycDropdown.style.display = 'none';
        };
      });
    }

    kycSearchInput.oninput = () => _kycRenderDropdown(kycSearchInput.value);
    kycSearchInput.onfocus = () => { if (kycSearchInput.value) _kycRenderDropdown(kycSearchInput.value); };
    // Close dropdown when clicking outside
    setTimeout(() => {
      const _closeKycDrop = e => {
        if (!kycSearchInput.contains(e.target) && !kycDropdown.contains(e.target)) {
          kycDropdown.style.display = 'none';
          document.removeEventListener('click', _closeKycDrop);
        }
      };
      document.addEventListener('click', _closeKycDrop);
    }, 0);
  }
  Modal.open('kycUploadModal');
}

function kycUploadHandleDrop(ev) {
  ev.preventDefault();
  const file = ev.dataTransfer?.files?.[0] || ev.target.files?.[0];
  if (file) _kycPreviewFile(file);
}

function kycUploadHandleFile(input) {
  const file = input.files?.[0];
  if (file) _kycPreviewFile(file);
}

function _kycPreviewFile(file) {
  const MAX = 10 * 1024 * 1024; // 10 MB
  const status = document.getElementById('kycUploadStatus');
  const preview = document.getElementById('kycUploadPreview');
  const label   = document.getElementById('kycUploadDropLabel');
  if (file.size > MAX) {
    status.textContent = '⚠ File too large (max 10 MB)';
    status.style.color = '#ef4444';
    return;
  }
  label.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB)`;
  status.textContent = '';
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const isPdf   = file.type === 'application/pdf';
    preview.innerHTML = isPdf
      ? `<div style="background:#1a1d23;border-radius:8px;padding:16px;text-align:center;margin-top:12px">
           <i class="fa-solid fa-file-pdf" style="font-size:2.5rem;color:#ef4444;margin-bottom:8px;display:block"></i>
           <div style="font-size:0.8rem;color:var(--text-muted)">${file.name}</div>
         </div>`
      : `<img src="${dataUrl}" alt="Preview" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:12px;display:block" />`;
    /* Store on the form element for retrieval on save */
    document.getElementById('kycUploadForm').dataset.fileData = dataUrl;
    document.getElementById('kycUploadForm').dataset.fileName = file.name;
    document.getElementById('kycUploadForm').dataset.fileSize = file.size;
    document.getElementById('kycUploadForm').dataset.mimeType = file.type;
  };
  reader.readAsDataURL(file);
}

async function saveKycUpload() {
  const form        = document.getElementById('kycUploadForm');
  const investorId  = document.getElementById('kycUploadInvestorId').value.trim();
  const invName     = document.getElementById('kycUploadInvestorName').value.trim();
  const docType     = document.getElementById('kycUploadDocType').value;
  const fileData    = form.dataset.fileData || '';
  const fileName    = form.dataset.fileName || '';
  const fileSize    = parseInt(form.dataset.fileSize)||0;
  const mimeType    = form.dataset.mimeType  || '';
  const statusVal   = document.getElementById('kycUploadStatusField').value || 'pending';
  const expiryDate  = document.getElementById('kycExpiryDate')?.value || null;
  const docSubtype  = document.getElementById('kycUploadDocSubtype')?.value || null;
  const statusEl    = document.getElementById('kycUploadStatus');

  if (!investorId) { statusEl.textContent = 'Please select an investor'; statusEl.style.color='#ef4444'; return; }
  if (!docType)    { statusEl.textContent = 'Please select a document type'; statusEl.style.color='#ef4444'; return; }
  if (!fileData) {
    statusEl.textContent = 'An attachment is required — please select a file to upload';
    statusEl.style.color = '#ef4444';
    const dz = document.getElementById('kycDropZone');
    if (dz) { dz.style.borderColor = '#ef4444'; setTimeout(() => { dz.style.borderColor = 'rgba(255,130,21,0.4)'; }, 2500); }
    return;
  }

  const saveBtn = document.getElementById('kycUploadSaveBtn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…';
  statusEl.textContent = '';

  try {
    await API.kyc.create({
      id:            `FICA-${Date.now()}`,
      investor_id:   investorId,
      investor_name: invName || undefined,
      doc_type:      docType,
      doc_subtype:   docSubtype || undefined,
      file_name:     fileName,
      file_data:     fileData,
      status:        statusVal,
      expiry_date:   expiryDate || null,
      notes:         `Uploaded via admin: ${invName}. Size: ${fileSize}. MIME: ${mimeType}.`
    });
    Toast.success('Document uploaded successfully');
    Modal.close('kycUploadModal');
    await loadKYC();
  } catch (e) {
    statusEl.textContent = 'Upload failed: ' + e.message;
    statusEl.style.color = '#ef4444';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload Document';
  }
}

/* ═══════════════════════════════════════════════
   GLOBAL SEARCH
   ═══════════════════════════════════════════════ */
function setupGlobalSearch() {
  const input = document.getElementById('globalSearch');
  if (!input || input.dataset.bound === '1') return;
  input.dataset.bound = '1';

  const dropdown = document.createElement('div');
  dropdown.id = 'globalSearchDropdown';
  dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--dark-2);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5);z-index:9999;max-height:420px;overflow-y:auto';
  input.parentElement.style.position = 'relative';
  input.parentElement.appendChild(dropdown);

  let flatResults = [];
  let activeIndex = -1;

  const close = () => {
    dropdown.style.display = 'none';
    activeIndex = -1;
  };
  const highlight = idx => {
    const items = [...dropdown.querySelectorAll('.gs-item')];
    items.forEach((el, itemIdx) => {
      el.style.background = itemIdx === idx ? 'rgba(254,194,79,0.08)' : '';
      el.setAttribute('aria-selected', itemIdx === idx ? 'true' : 'false');
    });
    activeIndex = idx;
    const active = items[idx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  };
  const renderHint = msg => {
    dropdown.innerHTML = `<div style="padding:16px 18px;color:var(--text-muted);font-size:0.8rem;line-height:1.5">${msg}</div>`;
    dropdown.style.display = 'block';
  };
  const runSearch = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    if (q.length < 2) {
      renderHint('Type at least 2 characters to search investors, pools and transactions. Use ↑ ↓ and Enter to move faster.');
      flatResults = [];
      return;
    }

    const groups = [];
    const investors = STATE.investors.filter(i => {
      const name = `${i.first_name||''} ${i.last_name||''}`.toLowerCase();
      return name.includes(q) || (i.email||'').toLowerCase().includes(q)
          || (i.id||'').toLowerCase().includes(q) || (i.phone||'').includes(q);
    }).slice(0, 5).map(i => ({
      icon: 'fa-user', color: '#fec24f',
      title: `${i.first_name} ${i.last_name}`,
      sub: `${i.id} · ${i.email}`,
      action: () => { input.value = ''; close(); navigate('investors', document.querySelector('[data-view=investors]')); setTimeout(() => { const el = document.getElementById('investorSearch'); if (el) { el.value = `${i.first_name} ${i.last_name}`; el.dispatchEvent(new Event('input')); } }, 200); }
    }));
    if (investors.length) groups.push({ label: 'Investors', items: investors });

    const pools = STATE.pools.filter(p => (p.name||'').toLowerCase().includes(q) || (p.product_type||'').toLowerCase().includes(q)).slice(0, 4).map(p => ({
      icon: 'fa-layer-group', color: '#656565',
      title: p.name,
      sub: `Pool · ${p.status} · ${Utils.rand(p.live_raised ?? p.raised_amount ?? 0)} raised`,
      action: () => { input.value = ''; close(); navigate('pools', document.querySelector('[data-view=pools]')); setTimeout(() => viewPoolInvestors(p.id), 300); }
    }));
    if (pools.length) groups.push({ label: 'Pools', items: pools });

    const transactions = STATE.transactions.filter(t => (t.reference||'').toLowerCase().includes(q) || (t.investor_id||'').toLowerCase().includes(q)).slice(0, 4).map(t => ({
      icon: 'fa-arrows-rotate', color: '#22c55e',
      title: `${t.type} — ${Utils.rand(t.amount)}`,
      sub: `Ref: ${t.reference||'—'} · ${Utils.date(t.transaction_date||t.created_at)}`,
      action: () => { input.value = ''; close(); navigate('transactions', document.querySelector('[data-view=transactions]')); setTimeout(() => { const el = document.getElementById('txnSearch'); if (el) { el.value = t.reference||''; el.dispatchEvent(new Event('input')); } }, 200); }
    }));
    if (transactions.length) groups.push({ label: 'Transactions', items: transactions });

    flatResults = groups.flatMap(group => group.items);
    if (!flatResults.length) {
      renderHint(`No matches for <strong>${_esc(q)}</strong>. Try an investor email, pool name or transaction reference.`);
      return;
    }

    let idx = 0;
    dropdown.innerHTML = `
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--dark-3);position:sticky;top:0;z-index:1">
        <span style="font-size:0.74rem;font-weight:800;color:var(--text);letter-spacing:0.02em">${flatResults.length} result${flatResults.length === 1 ? '' : 's'}</span>
        <span style="font-size:0.7rem;color:var(--text-dim)">↑ ↓ move · Enter open · Esc close</span>
      </div>
      ${groups.map(group => {
        const html = group.items.map(item => {
          const current = idx++;
          return `
            <div class="gs-item" data-idx="${current}" tabindex="0" role="option" aria-selected="false" style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border)">
              <div style="width:30px;height:30px;border-radius:8px;background:${item.color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <i class="fa-solid ${item.icon}" style="color:${item.color};font-size:0.8rem"></i>
              </div>
              <div style="min-width:0">
                <div style="font-size:0.82rem;font-weight:700;color:var(--text)">${item.title}</div>
                <div style="font-size:0.72rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.sub}</div>
              </div>
            </div>`;
        }).join('');
        return `<div><div style="padding:8px 16px 6px;font-size:0.68rem;font-weight:800;letter-spacing:0.08em;color:var(--text-dim);text-transform:uppercase;background:var(--dark-2)">${group.label}</div>${html}</div>`;
      }).join('')}`;

    dropdown.querySelectorAll('.gs-item').forEach((el, idx) => {
      el.addEventListener('mouseenter', () => highlight(idx));
      el.addEventListener('mouseleave', () => { if (activeIndex === idx) highlight(idx); else el.style.background = ''; });
      el.addEventListener('click', () => flatResults[idx].action());
      el.addEventListener('keydown', e => { if (e.key === 'Enter') flatResults[idx].action(); });
    });

    dropdown.style.display = 'block';
    highlight(0);
  };

  input.addEventListener('focus', () => {
    if (input.value.trim()) runSearch();
    else renderHint('Type at least 2 characters to search investors, pools and transactions.');
  });
  input.addEventListener('input', Utils.debounce(runSearch, 120));
  input.addEventListener('keydown', e => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (!flatResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight((activeIndex + 1) % flatResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight((activeIndex - 1 + flatResults.length) % flatResults.length);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      flatResults[activeIndex].action();
    }
  });

  document.addEventListener('click', e => {
    if (!input.parentElement.contains(e.target)) close();
  });
}

/* ═══════════════════════════════════════════════
   CSV EXPORT
   ═══════════════════════════════════════════════ */
function _downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportInvestorsCSV() {
  if (!STATE.investors.length) { Toast.error('Load investors first'); return; }
  const data = (filteredInvestors && filteredInvestors.length && filteredInvestors.length < STATE.investors.length)
    ? filteredInvestors : STATE.investors;
  const headers = ['ID','First Name','Last Name','Email','Phone','Gender','Heard About Us','FICA Status','Wallet Balance','Total Invested','Total Returns','Date Joined'];
  const rows = [headers, ...data.map(i => [
    i.id, i.first_name, i.last_name, i.email, i.phone || '',
    i.gender || '', i.heard_about_us || '',
    i.fica_status, i.wallet_balance || 0, i.total_invested || 0, i.total_returns || 0,
    i.date_joined ? new Date(i.date_joined).toLocaleDateString('en-ZA') : '',
  ])];
  _downloadCSV(rows, `investors-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${data.length} investors${data.length < STATE.investors.length ? ' (filtered)' : ''}`);
}

function exportTransactionsCSV() {
  if (!STATE.transactions.length) { Toast.error('Load transactions first'); return; }
  const headers = ['ID','Investor','Type','Amount','Status','Reference','Description','Date'];
  const rows = [headers, ...STATE.transactions.map(t => [
    t.id, _txnInvName(t), t.type, t.amount, t.status,
    t.reference || '', t.description || '',
    t.created_at ? new Date(t.created_at).toLocaleDateString('en-ZA') : '',
  ])];
  _downloadCSV(rows, `transactions-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.transactions.length} transactions`);
}

function exportKYCCSV() {
  if (!STATE.kyc.length) { Toast.error('Load KYC data first'); return; }
  const headers = ['ID','Investor','Investor ID','Document Type','File','Status','Submitted','Reviewed'];
  const rows = [headers, ...STATE.kyc.map(k => {
    const inv = STATE.investors.find(i => i.id === k.investor_id);
    const name = k.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : k.investor_id);
    return [k.id, name, k.investor_id, k.doc_type || k.document_type || '', k.file_name || '',
      k.status, Utils.date(k.submitted_at || k.submitted_date || k.created_at), Utils.date(k.reviewed_at)];
  })];
  _downloadCSV(rows, `kyc-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.kyc.length} KYC records`);
}

async function allocateInvestmentsToPools(btn) {
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Allocating…';
  try {
    const data = await API._fetch('POST', 'admin/investments/allocate-pools');
    const unmatchedNote = data.unmatched?.length
      ? ` (${data.unmatched.length} pool name${data.unmatched.length !== 1 ? 's' : ''} unmatched)`
      : '';
    Toast.success(`Allocated ${data.matched} investment${data.matched !== 1 ? 's' : ''} to pools${unmatchedNote}`);
    if (data.unmatched?.length) {
      console.warn('[allocate-pools] unmatched pool names:', data.unmatched);
    }
    STATE.investments = (await API.investments.list({ limit: 5000 })).data || [];
    filterInvestments();
  } catch (e) {
    Toast.error(e.message || 'Allocation failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-link"></i> Allocate to Pools';
  }
}

function exportInvestmentsCSV() {
  if (!STATE.investments.length) { Toast.error('Load investments first'); return; }
  const headers = ['ID','Investor ID','Pool','Product','Amount','Rate','Status','Start Date','End Date','Maturity Instruction'];
  const rows = [headers, ...STATE.investments.map(i => [
    i.id, i.investor_id, i.pool_name||'', i.product_type, i.amount,
    i.annual_rate||'', i.status, Utils.date(i.start_date), Utils.date(i.end_date), i.maturity_instruction||''
  ])];
  _downloadCSV(rows, `investments-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.investments.length} investments`);
}

function exportPoolsCSV() {
  if (!STATE.pools.length) { Toast.error('Load pools first'); return; }
  const headers = ['ID','Name','Product','Status','Target','Raised','Investors','Rate','Start','End'];
  const rows = [headers, ...STATE.pools.map(p => [
    p.id, p.name, p.product_type, p.status, p.target_amount||0,
    p.live_raised??p.raised_amount??0, p.live_investor_count??p.investor_count??0,
    p.annual_rate||'', Utils.date(p.start_date), Utils.date(p.end_date)
  ])];
  _downloadCSV(rows, `pools-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.pools.length} pools`);
}

function exportMaturityCSV() {
  if (!STATE.maturity.length) { Toast.error('Load maturity instructions first'); return; }
  const headers = ['Investor','Investor ID','Pool','Instruction','Payout','Status','Date'];
  const rows = [headers, ...STATE.maturity.map(m => {
    const inv = STATE.investors.find(i => i.id === m.investor_id);
    const name = m.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : m.investor_id);
    return [name, m.investor_id, m.pool_name||'—', m.instruction_type, m.total_payout||0, m.status, Utils.date(m.submitted_date||m.created_at)];
  })];
  _downloadCSV(rows, `maturity-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.maturity.length} maturity instructions`);
}

function exportWithdrawalsCSV() {
  const all = STATE.withdrawals || [];
  if (!all.length) { Toast.error('Load withdrawals first'); return; }
  const headers = ['ID','Investor Name','Investor ID','Amount','Bank','Account Number','Reference','Status','Date'];
  const rows = [headers, ...all.map(w => {
    const inv = STATE.investors.find(i => i.id === w.investor_id);
    const name = inv ? `${inv.first_name} ${inv.last_name}` : w.investor_id;
    let bankNotes = {}; try { if (inv?.notes?.startsWith('{')) bankNotes = JSON.parse(inv.notes); } catch(_) {}
    const bank    = inv?.bank_name           || bankNotes.bank_name      || '—';
    const acctNo  = inv?.bank_account_number || bankNotes.account_number || '—';
    return [w.id, name, w.investor_id, Math.abs(w.amount||0), bank, acctNo, w.reference||'', w.status, Utils.date(w.created_at||w.transaction_date)];
  })];
  _downloadCSV(rows, `withdrawals-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${all.length} withdrawals`);
}

/* ═══════════════════════════════════════════════
   BULK KYC OPERATIONS
   ═══════════════════════════════════════════════ */
let _kycSelected = new Set();

function _kycUpdateBulkBar() {
  const bar   = document.getElementById('kycBulkBar');
  const count = document.getElementById('kycBulkCount');
  if (!bar) return;
  if (_kycSelected.size > 0) {
    bar.style.display = 'flex';
    count.textContent = `${_kycSelected.size} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function toggleKycRow(id, checked) {
  if (checked) _kycSelected.add(id);
  else _kycSelected.delete(id);
  _kycUpdateBulkBar();
}

function toggleAllKyc(checked) {
  const filter = document.getElementById('kycStatusFilter').value;
  const items  = filter ? STATE.kyc.filter(k => k.status === filter) : STATE.kyc;
  const actionable = items.filter(k => ['pending', 'under_review'].includes(k.status));
  if (checked) actionable.forEach(k => _kycSelected.add(k.id));
  else _kycSelected.clear();
  _kycUpdateBulkBar();
  document.querySelectorAll('.kyc-cb').forEach(cb => {
    if (actionable.find(k => k.id == cb.value)) cb.checked = checked;
  });
}

function clearKycSelection() {
  _kycSelected.clear();
  _kycUpdateBulkBar();
  document.querySelectorAll('.kyc-cb').forEach(cb => { cb.checked = false; });
  const all = document.getElementById('kycSelectAll');
  if (all) all.checked = false;
}

async function bulkApproveKyc() {
  if (!_kycSelected.size) return;
  const ids = [..._kycSelected];
  if (!await Confirm.ask(`Approve ${ids.length} document(s)?`, { body: `All selected KYC documents will be marked as approved.`, confirmLabel: 'Approve All' })) return;
  const total = ids.length;
  const approveBtn = document.querySelector('[onclick="bulkApproveKyc()"]');
  const rejectBtn  = document.querySelector('[onclick="bulkRejectKyc()"]');
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn)  rejectBtn.disabled  = true;
  try {
    const reviewedBy = _getAdminName();
    const reviewedDate = new Date().toISOString();
    for (let i = 0; i < ids.length; i++) {
      await API.kyc.update(ids[i], { status: 'approved', reviewed_by: reviewedBy, reviewed_at: reviewedDate });
      // Sync investor record so status/badges reflect approval
      const doc = STATE.kyc.find(k => k.id === ids[i]);
      if (doc?.investor_id) {
        await API._fetch('PATCH', `tables/investors/${doc.investor_id}`, { kyc_status: 'approved', fica_status: 'approved', status: 'active' });
      }
      if ((i + 1) % 5 === 0) Toast.info(`Processing ${i + 1}/${total}...`);
    }
    _kycSelected.clear();
    Toast.success(`${ids.length} document(s) approved — investor records updated`);
    await loadKYC();
  } catch (e) { Toast.error('Bulk approve failed'); }
  finally {
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn)  rejectBtn.disabled  = false;
  }
}

async function bulkRejectKyc() {
  if (!_kycSelected.size) return;
  // Open the shared reject modal to collect the reason (with template chips)
  _rejectingKycId = '__bulk__'; // sentinel for bulk mode
  _rejectingTxnId = null;
  _rejectMode = 'kyc';
  _rejectBtn = null;
  document.getElementById('rejectModalTitle').textContent = `Reject ${_kycSelected.size} KYC Document${_kycSelected.size > 1 ? 's' : ''}`;
  document.getElementById('rejectModalBody').textContent = `All selected documents will be marked as rejected. Provide a reason (optional).`;
  document.getElementById('rejectReasonInput').value = '';
  const tpl = document.getElementById('kycRejectTemplates');
  if (tpl) tpl.style.display = '';
  const emailRow = document.getElementById('kycRejectEmailRow');
  if (emailRow) emailRow.style.display = '';
  const emailCb = document.getElementById('kycRejectEmailInvestor');
  if (emailCb) emailCb.checked = true;
  const overlay = document.getElementById('rejectModal');
  overlay.style.display = 'flex';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('rejectReasonInput')?.focus(), 100);
}

async function _executeBulkKycReject(reason, shouldEmail) {
  const ids = [..._kycSelected];
  const total = ids.length;
  const approveBtn = document.querySelector('[onclick="bulkApproveKyc()"]');
  const rejectBtn  = document.querySelector('[onclick="bulkRejectKyc()"]');
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn)  rejectBtn.disabled  = true;
  try {
    const reviewedBy  = _getAdminName();
    const reviewedAt  = new Date().toISOString();
    for (let i = 0; i < ids.length; i++) {
      await API.kyc.update(ids[i], { status: 'rejected', notes: reason || 'Rejected by admin.', reviewed_by: reviewedBy, reviewed_at: reviewedAt });
      if (shouldEmail) {
        const doc = STATE.kyc.find(k => k.id === ids[i]);
        const inv = doc?.investor_id ? STATE.investors.find(i2 => i2.id === doc.investor_id) : null;
        if (inv?.email) {
          const DOC_LABELS = { id_document: 'Identity Document', proof_of_address: 'Proof of Address', proof_of_bank: 'Proof of Bank Account' };
          const docLabel = DOC_LABELS[doc.doc_type] || 'KYC document';
          await API._fetch('POST', 'admin/send-investor-email', {
            investor_id: inv.id,
            subject: `Action required: Your ${docLabel} — SV Capital`,
            message: `Dear ${inv.first_name || 'Investor'},\n\nYour ${docLabel} requires attention.\n\nReason: ${reason || 'Please re-upload a valid document.'}\n\nLog in to your investor portal to resubmit.\n\nKind regards,\nSV Capital Compliance Team`,
          }).catch(() => {});
        }
      }
      if ((i + 1) % 5 === 0) Toast.info(`Processing ${i + 1}/${total}...`);
    }
    _kycSelected.clear();
    Toast.success(`${total} document(s) rejected${shouldEmail ? ' — investors notified' : ''}`);
    await loadKYC();
  } catch (e) { Toast.error('Bulk reject failed'); }
  finally {
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn)  rejectBtn.disabled  = false;
  }
}

/* ═══════════════════════════════════════════════
   AUDIT LOG — Feature 6: Real Audit Log
   ═══════════════════════════════════════════════ */
let _auditEvents = [];
let _auditPage   = 1;
const AUDIT_PG   = 50;

async function loadAuditLog() {
  try {
    // Build server-side query params
    const typeFilter  = document.getElementById('auditTypeFilter')?.value  || '';
    const searchQ     = document.getElementById('auditSearchInput')?.value || '';
    const dateFromVal = document.getElementById('auditDateFrom')?.value    || '';
    const dateToVal   = document.getElementById('auditDateTo')?.value      || '';

    const params = { limit: AUDIT_PG, page: _auditPage, sort: 'created_at', order: 'desc' };
    if (typeFilter)  params.event_type = typeFilter;
    if (searchQ)     params.search     = searchQ;
    if (dateFromVal) params.date_from  = dateFromVal;
    if (dateToVal)   params.date_to    = dateToVal;

    const res = await API._fetch('GET', 'tables/audit_events', null, params);
    _auditEvents = res.data || [];
    renderAuditTable(res);

    // Wire filters once (guard against double-wiring)
    const typeF    = document.getElementById('auditTypeFilter');
    const searchF  = document.getElementById('auditSearchInput');
    const dateFrom = document.getElementById('auditDateFrom');
    const dateTo   = document.getElementById('auditDateTo');

    const resetAndRender = () => { _auditPage = 1; loadAuditLog(); };
    if (typeF   && !typeF._auditWired)   { typeF.addEventListener('change', resetAndRender);   typeF._auditWired = true; }
    if (searchF && !searchF._auditWired) { searchF.addEventListener('input', Utils.debounce(resetAndRender, 250)); searchF._auditWired = true; }
    if (dateFrom && !dateFrom._auditWired) { dateFrom.addEventListener('change', resetAndRender); dateFrom._auditWired = true; }
    if (dateTo   && !dateTo._auditWired)   { dateTo.addEventListener('change', resetAndRender);   dateTo._auditWired   = true; }
  } catch (e) { Toast.error('Failed to load audit log'); }
}

function _auditPrevPage() {
  if (_auditPage <= 1) return;
  _auditPage--;
  loadAuditLog();
}

function _auditNextPage() {
  _auditPage++;
  loadAuditLog();
}

function renderAuditTable(res) {
  const body = document.getElementById('auditBody');
  if (!body) return;

  const items = _auditEvents;
  const total = res?.total ?? items.length;

  const footer = document.getElementById('auditFooter');
  if (footer) footer.textContent = total
    ? `Page ${_auditPage} · ${items.length} of ${total.toLocaleString()} events`
    : '0 events';

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:32px">No audit events found</td></tr>';
    const pag = document.getElementById('auditPagination');
    if (pag) pag.innerHTML = _auditPage > 1
      ? `<button class="page-btn" onclick="_auditPrevPage()">‹ Prev</button>`
      : '';
    return;
  }

  const actionColor = {
    'user.login': 'blue', 'login': 'blue',
    'kyc.approved': 'green', 'kyc.rejected': 'red',
    'transaction.completed': 'green', 'transaction.rejected': 'red',
    'investment.paid_out': 'gold', 'investment.created': 'green',
    'withdrawal.approved': 'green', 'withdrawal.rejected': 'red',
    'withdrawal.submitted': 'blue',
  };

  body.innerHTML = items.map(e => {
    const action      = e.event_type || '—';
    const actor       = e.user_email || '—';
    const actorRole   = e.actor_role || '—';
    const target      = e.entity_type
      ? `${e.entity_type}${e.entity_id ? ' #' + String(e.entity_id).slice(0, 8) : ''}`
      : '—';
    const ip          = e.ip_address || '—';
    const desc        = e.description || '';
    const badgeClass  = actionColor[action] || 'gray';

    return `<tr>
      <td class="td-muted clip" style="font-size:0.75rem">${Utils.date(e.created_at)}</td>
      <td><div class="clip" style="font-size:0.78rem;font-weight:600">${_esc(actor)}</div>
          ${actorRole !== '—' ? `<div class="clip" style="font-size:0.68rem;color:var(--text-muted)">${_esc(actorRole)}</div>` : ''}</td>
      <td><span class="badge badge--${badgeClass} clip" style="font-size:0.7rem">${_esc(action)}</span></td>
      <td class="td-muted clip" style="font-size:0.75rem">${_esc(target)}</td>
      <td class="td-muted clip" style="font-size:0.72rem" title="${_esc(desc)}">${_esc(desc) || '—'}</td>
      <td class="td-muted clip" style="font-size:0.72rem">${_esc(ip)}</td>
    </tr>`;
  }).join('');

  // Pagination controls
  const pag = document.getElementById('auditPagination');
  if (pag) {
    const hasPrev = _auditPage > 1;
    const hasNext = items.length === AUDIT_PG;
    pag.innerHTML = [
      hasPrev ? `<button class="page-btn" onclick="_auditPrevPage()">‹ Prev</button>` : '',
      `<span class="page-btn active" style="cursor:default">${_auditPage}</span>`,
      hasNext ? `<button class="page-btn" onclick="_auditNextPage()">Next ›</button>` : '',
    ].join('');
  }
}

/* ═══════════════════════════════════════════════
   OPERATIONS CONSOLE
   ═══════════════════════════════════════════════ */

let _opsVelocityChart = null;
let _opsAumByTypeChart = null;
let _opsSummaryCache = null;

async function _opsGet(path) {
  const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
  const res = await fetch(`/api/opsconsole/${path}`, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function _opsR(v) {
  if (v == null || isNaN(v)) return '—';
  if (v >= 1_000_000) return `R${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `R${(v / 1_000).toFixed(1)}k`;
  return `R${Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 0 })}`;
}

function _applyEmailToggleUI(enabled) {
  const chk   = document.getElementById('emailToggleChk');
  const track  = document.getElementById('emailToggleTrack');
  const thumb  = document.getElementById('emailToggleThumb');
  const label  = document.getElementById('emailToggleLabel');
  const status = document.getElementById('emailControlsStatus');
  if (chk)   { chk.checked = enabled; chk.disabled = false; }
  if (track)  track.style.background = enabled ? '#22c55e' : '#3f3f3f';
  if (thumb)  thumb.style.transform  = enabled ? 'translateX(22px)' : 'none';
  if (label)  { label.textContent = enabled ? 'Enabled' : 'Disabled'; label.style.color = enabled ? '#22c55e' : '#ef4444'; }
  if (status) status.textContent = enabled ? 'Emails are being sent' : 'All emails suppressed';
}

async function _loadEmailToggle() {
  try {
    const res = await fetch('/api/settings/email-toggle', { credentials: 'include' });
    if (!res.ok) throw new Error(res.statusText);
    const { enabled } = await res.json();
    _applyEmailToggleUI(enabled);
  } catch (e) {
    console.error('[emailToggle] load failed:', e);
    const status = document.getElementById('emailControlsStatus');
    if (status) status.textContent = 'Failed to load — refresh to retry';
  }
}

async function toggleEmailDelivery() {
  const chk = document.getElementById('emailToggleChk');
  if (!chk || chk.disabled) return;
  const newVal = !chk.checked;
  chk.disabled = true;
  try {
    const res = await fetch('/api/settings/email-toggle', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: newVal }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    _applyEmailToggleUI(newVal);
    Toast.success(newVal ? 'Email delivery enabled' : 'Email delivery disabled');
  } catch (e) {
    Toast.error('Failed to update email setting');
    chk.disabled = false;
  }
}

async function loadOpsConsole() {
  _loadEmailToggle().catch(() => {});
  try {
    const [summary, health, funnel, comms, activity, velocity] = await Promise.all([
      _opsGet('summary').catch(() => null),
      _opsGet('health').catch(() => null),
      _opsGet('funnel').catch(() => null),
      _opsGet('comms').catch(() => null),
      _opsGet('activity').catch(() => null),
      _opsGet('velocity').catch(() => null),
    ]);

    _opsSummaryCache = summary;

    if (health) _opsRenderHealth(health);
    if (summary) _opsRenderKpis(summary);
    if (summary) _opsRenderMoney(summary);
    if (summary) _opsRenderInvestorPulse(summary);
    if (funnel)  _opsRenderFunnel(funnel);
    if (summary) _opsRenderAumByType(summary);
    if (summary) _opsRenderTopPools(summary);
    if (velocity) _opsRenderVelocity(velocity);
    if (comms)   _opsRenderComms(comms);
    if (activity) _opsRenderAuditStream(activity);
  } catch (e) {
    console.error('[loadOpsConsole]', e);
    Toast.error('Operations Console failed to load');
  }
}

function _opsRenderHealth(health) {
  const grid = document.getElementById('opsHealthGrid');
  const checkedEl = document.getElementById('opsHealthChecked');
  if (!grid) return;
  if (checkedEl && health.checkedAt) {
    checkedEl.textContent = `Last checked: ${new Date(health.checkedAt).toLocaleTimeString('en-ZA')}`;
  }
  const services = health.services || {};
  grid.innerHTML = Object.entries(services).map(([key, svc]) => {
    const ok   = svc.ok;
    const conf = svc.configured;
    const color  = ok ? '#22c55e' : conf ? '#ef4444' : '#9ca3af';
    const icon   = ok ? 'fa-circle-check' : conf ? 'fa-circle-xmark' : 'fa-circle-minus';
    const status = ok ? 'Online' : conf ? 'Error' : 'Not configured';
    const latency = (svc.ms && svc.ms > 0) ? `${svc.ms}ms` : '';
    const extra  = key === 'push' ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">${(svc.subscribers||0).toLocaleString()} subscribers</div>` : svc.note ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px">${svc.note}</div>` : latency ? `<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px">${latency}</div>` : '';
    return `<div style="padding:14px 12px;border:1.5px solid ${color}22;border-radius:12px;background:${color}08;text-align:center">
      <i class="fa-solid ${icon}" style="font-size:1.4rem;color:${color};margin-bottom:6px"></i>
      <div style="font-size:0.78rem;font-weight:800;color:#e8edf2;line-height:1.2;margin-bottom:2px">${svc.name}</div>
      <div style="font-size:0.72rem;font-weight:700;color:${color}">${status}</div>
      ${extra}
    </div>`;
  }).join('');
}

function _opsRenderKpis(s) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ops-aum',      _opsR(s.aum));
  set('ops-wallets',  _opsR(s.totalWalletBalance));
  set('ops-dep-val',  s.pendingDeposits?.count != null ? `${s.pendingDeposits.count} · ${_opsR(s.pendingDeposits.value)}` : '—');
  set('ops-with-val', s.pendingWithdrawals?.count != null ? `${s.pendingWithdrawals.count} · ${_opsR(s.pendingWithdrawals.value)}` : '—');
  set('ops-fica',     s.investors?.ficaPending ?? '—');
  set('ops-tickets',  s.operations?.openTickets ?? '—');
}

function _opsRenderMoney(s) {
  const el = document.getElementById('opsMoneyPanel');
  if (!el) return;
  const row = (icon, label, val, color, note) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="width:36px;height:36px;border-radius:10px;background:${color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <i class="fa-solid ${icon}" style="color:${color};font-size:0.9rem"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.78rem;color:var(--text-muted);font-weight:600">${label}</div>
        ${note ? `<div style="font-size:0.68rem;color:var(--text-muted)">${note}</div>` : ''}
      </div>
      <div style="font-size:0.92rem;font-weight:900;color:#e8edf2;white-space:nowrap">${val}</div>
    </div>`;
  el.innerHTML = `
    ${row('fa-chart-line', 'Total AUM (active investments)', _opsR(s.aum), '#22c55e')}
    ${row('fa-wallet', 'Total wallet pool', _opsR(s.totalWalletBalance), '#656565')}
    ${row('fa-arrow-down-to-arc', `Pending deposits (${s.pendingDeposits?.count ?? 0})`, _opsR(s.pendingDeposits?.value), '#22c55e', 'Awaiting admin approval')}
    ${row('fa-arrow-up-from-arc', `Pending withdrawals (${s.pendingWithdrawals?.count ?? 0})`, _opsR(s.pendingWithdrawals?.value), '#fec24f', 'In payout queue')}
    ${row('fa-clock', `Pending investments (${s.pendingInvestments?.count ?? 0})`, _opsR(s.pendingInvestments?.value), '#eda5ff', 'Awaiting allocation')}
    ${row('fa-coins', 'Deposits this month', _opsR(s.monthDeposits?.value), '#656565', `${s.monthDeposits?.count ?? 0} transactions`)}
    ${row('fa-hand-holding-dollar', 'Returns distributed this month', _opsR(s.returnsDistributed), '#22c55e')}
    ${row('fa-bolt', 'Deposit velocity (7 days)', _opsR(s.investVol7d), '#fec24f')}
  `.replace(/<div[^>]*><\/div>$/, '');
}

function _opsRenderInvestorPulse(s) {
  const el = document.getElementById('opsInvestorPulse');
  if (!el) return;
  const inv = s.investors || {};
  const growthPct = inv.prevMonth > 0 ? (((inv.newMonth - inv.prevMonth) / inv.prevMonth) * 100).toFixed(1) : null;
  const growthHtml = growthPct !== null
    ? `<span style="font-size:0.72rem;color:${parseFloat(growthPct)>=0?'#22c55e':'#ef4444'};font-weight:700;margin-left:6px">${parseFloat(growthPct)>=0?'↑':'↓'}${Math.abs(growthPct)}% vs last month</span>`
    : '';
  const tile = (label, val, color) =>
    `<div style="text-align:center;padding:12px 8px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:rgba(255,255,255,0.05)">
      <div style="font-size:1.2rem;font-weight:900;color:${color}">${val ?? '—'}</div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;font-weight:600">${label}</div>
    </div>`;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      ${tile('Total', inv.total, '#e8edf2')}
      ${tile('Active Investors', inv.active, '#22c55e')}
      ${tile('FICA Approved', inv.ficaApproved, '#656565')}
      ${tile('FICA Pending', inv.ficaPending, '#fec24f')}
      ${tile('New Today', inv.newToday, '#eda5ff')}
      ${tile('New This Month', inv.newMonth, '#fec24f')}
    </div>
    <div style="display:flex;align-items:center;padding:10px 12px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:10px;font-size:0.82rem;color:#e8edf2">
      <i class="fa-solid fa-user-plus" style="color:#656565;margin-right:8px"></i>
      <strong>${inv.newWeek ?? '—'}</strong>&nbsp;new investors this week ${growthHtml}
    </div>
  `;
}

function _opsRenderFunnel(funnel) {
  const el = document.getElementById('opsFunnelPanel');
  if (!el || !funnel.stages?.length) return;
  const stages = funnel.stages;
  const max = stages[0]?.count || 1;
  el.innerHTML = stages.map((stage, i) => {
    const pct = Math.round((stage.count / max) * 100);
    const convPct = i > 0 ? Math.round((stage.count / stages[i-1].count) * 100) : 100;
    const color = ['#656565','#22c55e','#fec24f','#eda5ff','#fec24f'][i] || '#656565';
    return `<div style="margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:0.78rem;font-weight:700;color:#e8edf2">${stage.label}</span>
        <div style="display:flex;align-items:center;gap:8px">
          ${i > 0 ? `<span style="font-size:0.68rem;color:${convPct >= 50 ? '#22c55e' : '#fec24f'};font-weight:700">${convPct}% from prev</span>` : ''}
          <span style="font-size:0.82rem;font-weight:900;color:#e8edf2">${(stage.count||0).toLocaleString()}</span>
        </div>
      </div>
      <div style="height:8px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:999px;transition:width 0.4s ease"></div>
      </div>
    </div>`;
  }).join('');
}

function _opsRenderAumByType(s) {
  const ctx = document.getElementById('opsAumByTypeChart');
  if (!ctx || !s.aumByType?.length) return;
  if (_opsAumByTypeChart) { _opsAumByTypeChart.destroy(); _opsAumByTypeChart = null; }
  const typeLabel = { cattle: 'Cattle', solar: 'Solar', short_term: 'Short-Term', delivery: 'Delivery' };
  const colors = ['#fec24f','#22c55e','#656565','#eda5ff','#fec24f','#656565'];
  const labels  = s.aumByType.map(r => typeLabel[r.type] || r.type);
  const data    = s.aumByType.map(r => r.volume);
  _opsAumByTypeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderWidth: 2, borderColor: '#1a2535' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 11 }, padding: 12 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${_opsR(c.parsed)}` } },
      },
    },
  });
}

function _opsRenderTopPools(s) {
  const el = document.getElementById('opsTopPools');
  if (!el || !s.topPools?.length) { if (el) el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.82rem">No pool data</div>'; return; }
  const maxVol = Math.max(...s.topPools.map(p => p.volume), 1);
  const typeColor = { cattle: '#fec24f', solar: '#22c55e', short_term: '#656565', delivery: '#eda5ff' };
  el.innerHTML = s.topPools.map((p, i) => {
    const pct = Math.round((p.volume / maxVol) * 100);
    const color = typeColor[p.type] || '#9ca3af';
    return `<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:18px;height:18px;border-radius:50%;background:${color};display:inline-flex;align-items:center;justify-content:center;font-size:0.6rem;font-weight:900;color:#fff;flex-shrink:0">${i+1}</span>
          <span style="font-size:0.8rem;font-weight:700;color:#e8edf2">${p.name}</span>
        </div>
        <div style="text-align:right">
          <div style="font-size:0.82rem;font-weight:900;color:#e8edf2">${_opsR(p.volume)}</div>
          <div style="font-size:0.68rem;color:var(--text-muted)">${p.investors} investors</div>
        </div>
      </div>
      <div style="height:5px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:999px"></div>
      </div>
    </div>`;
  }).join('');
}

function _opsRenderVelocity(velocity) {
  const ctx = document.getElementById('opsVelocityChart');
  if (!ctx) return;
  if (_opsVelocityChart) { _opsVelocityChart.destroy(); _opsVelocityChart = null; }

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const dayLabel = d => { const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }); };

  const rows = velocity.velocity || [];
  const getVol = (day, type) => {
    const r = rows.find(r => r.day?.slice(0,10) === day && r.type === type);
    return r ? parseFloat(r.volume) : 0;
  };

  _opsVelocityChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(dayLabel),
      datasets: [
        { label: 'Deposits', data: days.map(d => getVol(d, 'deposit')), backgroundColor: 'rgba(34,197,94,0.7)', borderColor: '#22c55e', borderWidth: 1, borderRadius: 4 },
        { label: 'Withdrawals', data: days.map(d => getVol(d, 'withdrawal')), backgroundColor: 'rgba(239,68,68,0.6)', borderColor: '#ef4444', borderWidth: 1, borderRadius: 4 },
        { label: 'Returns', data: days.map(d => getVol(d, 'return')), backgroundColor: 'rgba(254,194,79,0.6)', borderColor: '#fec24f', borderWidth: 1, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#7a92a8', font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${_opsR(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#7a92a8', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#7a92a8', callback: v => 'R'+(v/1000).toFixed(0)+'k' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        stacked: false,
      },
    },
  });
}

function _opsRenderComms(comms) {
  const el = document.getElementById('opsCommsPanel');
  if (!el) return;
  const push = comms.push || {};
  const recent = comms.recentNotifications || [];
  const tile = (icon, label, val, color) =>
    `<div style="text-align:center;padding:14px 10px;border:1px solid rgba(255,255,255,0.08);border-radius:12px;background:rgba(255,255,255,0.05)">
      <i class="fa-solid ${icon}" style="color:${color};font-size:1.2rem;margin-bottom:6px"></i>
      <div style="font-size:1.1rem;font-weight:900;color:#e8edf2">${val ?? '—'}</div>
      <div style="font-size:0.7rem;color:var(--text-muted);font-weight:600;margin-top:2px">${label}</div>
    </div>`;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
      ${tile('fa-bell', 'Push Subscribers', (push.subscribers||0).toLocaleString(), '#656565')}
      ${tile('fa-paper-plane', 'Pushes Sent (month)', push.sentThisMonth ?? 0, '#22c55e')}
      ${tile('fa-users', 'Push Recipients (month)', (push.recipientsThisMonth||0).toLocaleString(), '#eda5ff')}
    </div>
    ${recent.length ? `
      <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#7a92a8;font-weight:800;margin-bottom:8px">Recent Push Notifications</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${recent.map(n => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px">
            <i class="fa-solid fa-bell" style="color:#656565;font-size:0.8rem;flex-shrink:0"></i>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.78rem;font-weight:700;color:#e8edf2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${n.title || '(no title)'}</div>
              <div style="font-size:0.7rem;color:var(--text-muted)">${n.body ? n.body.slice(0,60)+'…' : ''}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:0.75rem;font-weight:700;color:#e8edf2">${(n.recipient_count||0).toLocaleString()} recv</div>
              <div style="font-size:0.65rem;color:var(--text-muted)">${new Date(n.created_at).toLocaleDateString('en-ZA')}</div>
            </div>
          </div>`).join('')}
      </div>` : '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.82rem">No push notifications sent yet.</div>'}
  `;
}

const _ACTION_COLOR = {
  'withdrawal.approved':'#22c55e', 'withdrawal.rejected':'#ef4444',
  'investment.created':'#656565', 'investment.approved':'#22c55e',
  'kyc.approved':'#22c55e', 'kyc.rejected':'#ef4444',
  'investor.suspended':'#ef4444', 'broadcast.sent':'#eda5ff',
  'deposit.approved':'#22c55e', 'deposit.rejected':'#ef4444',
};

function _opsRenderAuditStream(activity) {
  const el = document.getElementById('opsAuditStream');
  if (!el) return;
  const events = activity.events || [];
  if (!events.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.82rem">No audit events yet.</div>'; return; }
  el.innerHTML = events.map(ev => {
    const color = _ACTION_COLOR[ev.action] || '#9ca3af';
    const ago = _timeAgo(ev.created_at);
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;margin-top:5px"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.76rem;font-weight:700;color:#e8edf2">${ev.action || ev.entity_type || 'event'}</div>
        <div style="font-size:0.7rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ev.description || '—'}</div>
        <div style="font-size:0.65rem;color:#7a92a8;margin-top:1px">${ev.actor_email || 'system'} · ${ago}</div>
      </div>
    </div>`;
  }).join('');
}

function _timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

async function opsExportSummary() {
  try {
    const s = _opsSummaryCache;
    if (!s) { Toast.error('Load the console first'); return; }
    const rows = [
      ['Metric', 'Value'],
      ['AUM (Active)', s.aum],
      ['Total Wallet Pool', s.totalWalletBalance],
      ['Pending Deposits (count)', s.pendingDeposits?.count],
      ['Pending Deposits (value)', s.pendingDeposits?.value],
      ['Pending Withdrawals (count)', s.pendingWithdrawals?.count],
      ['Pending Withdrawals (value)', s.pendingWithdrawals?.value],
      ['Total Investors', s.investors?.total],
      ['Active Investors', s.investors?.active],
      ['FICA Pending', s.investors?.ficaPending],
      ['FICA Approved', s.investors?.ficaApproved],
      ['New Today', s.investors?.newToday],
      ['New This Week', s.investors?.newWeek],
      ['New This Month', s.investors?.newMonth],
      ['Returns Distributed (month)', s.returnsDistributed],
      ['Open Support Tickets', s.operations?.openTickets],
      ['AML Flags', s.operations?.amlFlags],
      ['Exported', new Date().toISOString()],
    ];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `ops-summary-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    Toast.success('Ops summary exported');
  } catch (e) {
    Toast.error('Export failed');
  }
}

/* ═══════════════════════════════════════════════
   BROADCAST COMMUNICATIONS (Feature 9)
   ═══════════════════════════════════════════════ */
let _broadcastHistory = [];

let _segPickerOpen  = false;

/* ── Segment picker data ─────────────────────────────────────── */
const _SEGMENT_BASE = [
  { value: 'all',            label: 'All Investors',           icon: 'fa-users',            desc: 'Everyone with an email address' },
  { value: 'active',         label: 'Active Investors',        icon: 'fa-circle-check',     desc: 'Currently have an active investment' },
  { value: 'no_investments', label: 'No Investments Yet',      icon: 'fa-user-clock',       desc: 'Registered but never invested' },
  { value: 'matured',        label: 'Matured Investors',       icon: 'fa-flag-checkered',   desc: 'Had at least one matured investment' },
  { value: 'wallet_positive',label: 'Positive Wallet Balance', icon: 'fa-wallet',           desc: 'Wallet balance greater than R0' },
  { value: 'pending_fica',   label: 'Pending FICA / KYC',      icon: 'fa-id-card',          desc: 'Documents awaiting verification' },
];

function _buildSegmentGroups() {
  return [
    { label: 'General', items: _SEGMENT_BASE },
    {
      label: 'By Pool',
      items: (STATE.pools || []).map(p => ({
        value: p.id,
        label: p.name,
        icon: 'fa-layer-group',
        desc: p.product_type || 'Investment pool',
      })),
    },
  ];
}

function buildSegmentPicker() { _renderSegmentList(''); }

function _renderSegmentList(q) {
  const listEl = document.getElementById('segmentPickerList');
  if (!listEl) return;
  const ql = (q || '').toLowerCase();
  const groups = _buildSegmentGroups();
  const currentVal = document.getElementById('broadcastSegment')?.value || 'all';
  let html = '';
  for (const g of groups) {
    const items = ql
      ? g.items.filter(i => i.label.toLowerCase().includes(ql) || (i.desc || '').toLowerCase().includes(ql))
      : g.items;
    if (!items.length) continue;
    html += `<div style="padding:7px 14px 3px;font-size:0.67rem;font-weight:700;letter-spacing:0.07em;color:var(--text-dim);text-transform:uppercase">${_esc(g.label)}</div>`;
    for (const item of items) {
      const sel = currentVal === item.value;
      html += `<div onclick='selectSegment(${JSON.stringify(item.value)},${JSON.stringify(item.label)},${JSON.stringify(item.icon)})'
        style="display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;border-radius:6px;margin:1px 4px;background:${sel ? 'rgba(237,165,255,0.12)' : ''}"
        onmouseenter="this.style.background='${sel ? 'rgba(237,165,255,0.15)' : 'rgba(255,255,255,0.04)'}'"
        onmouseleave="this.style.background='${sel ? 'rgba(237,165,255,0.12)' : ''}'">
        <i class="fa-solid ${_esc(item.icon)}" style="width:15px;text-align:center;color:${sel ? '#eda5ff' : 'var(--text-dim)'};font-size:0.82rem;flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.84rem;font-weight:${sel ? '600' : '400'};color:${sel ? 'var(--white)' : 'var(--text)'}">${_esc(item.label)}</div>
          ${item.desc ? `<div style="font-size:0.71rem;color:var(--text-dim);margin-top:1px">${_esc(item.desc)}</div>` : ''}
        </div>
        ${sel ? '<i class="fa-solid fa-check" style="color:#eda5ff;font-size:0.72rem;flex-shrink:0"></i>' : ''}
      </div>`;
    }
  }
  listEl.innerHTML = html || '<div style="padding:18px;text-align:center;color:var(--text-dim);font-size:0.82rem">No segments match</div>';
}

function filterSegments(q) { _renderSegmentList(q); }

function selectSegment(value, label, icon) {
  const hidden = document.getElementById('broadcastSegment');
  if (hidden) hidden.value = value;
  const labelEl = document.getElementById('segmentPickerLabel');
  if (labelEl) labelEl.textContent = label;
  const iconEl = document.getElementById('segmentPickerIcon');
  if (iconEl) { iconEl.className = `fa-solid ${icon}`; }
  closeSegmentPicker();
  updateBroadcastPreview();
}

function toggleSegmentPicker() { _segPickerOpen ? closeSegmentPicker() : openSegmentPicker(); }

function openSegmentPicker() {
  const dd = document.getElementById('segmentPickerDropdown');
  const ch = document.getElementById('segmentPickerChevron');
  const sr = document.getElementById('segmentPickerSearch');
  if (dd) dd.style.display = 'block';
  if (ch) ch.style.transform = 'rotate(180deg)';
  if (sr) { sr.value = ''; sr.focus(); }
  _segPickerOpen = true;
  _renderSegmentList('');
  setTimeout(() => document.addEventListener('click', _segPickerOutside, { once: true }), 0);
}

function closeSegmentPicker() {
  const dd = document.getElementById('segmentPickerDropdown');
  const ch = document.getElementById('segmentPickerChevron');
  if (dd) dd.style.display = 'none';
  if (ch) ch.style.transform = '';
  _segPickerOpen = false;
}

function _segPickerOutside(e) {
  const wrap = document.getElementById('segmentPickerWrap');
  if (wrap && !wrap.contains(e.target)) {
    closeSegmentPicker();
  } else if (_segPickerOpen) {
    setTimeout(() => document.addEventListener('click', _segPickerOutside, { once: true }), 0);
  }
}

async function loadComms() {
  buildSegmentPicker();
  toggleBroadcastSubject();
  updateBroadcastPreview();
  _renderBroadcastHistory();
  loadPushAnalytics();
}

function toggleBroadcastSubject() {
  const channel = document.querySelector('input[name="broadcastChannel"]:checked')?.value || 'email';
  const group   = document.getElementById('broadcastSubjectGroup');
  // Hide subject only for SMS-only channel
  if (group) group.style.display = channel === 'sms' ? 'none' : '';

  // Show/hide push subscriber warning
  let warnEl = document.getElementById('pushSubWarnBanner');
  if (channel === 'push' || channel === 'all') {
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.id = 'pushSubWarnBanner';
      warnEl.style.cssText = 'display:none;margin-bottom:12px;padding:10px 14px;background:rgba(254,194,79,0.1);border:1px solid rgba(254,194,79,0.3);border-radius:8px;font-size:0.82rem;color:var(--text-muted)';
      const previewBar = document.getElementById('broadcastPreviewBar');
      if (previewBar) previewBar.after(warnEl);
    }
    // Check subscriber count from analytics panel
    const subCount = parseInt(document.getElementById('pushStatSubscribers')?.textContent || '-1');
    if (subCount === 0) {
      warnEl.innerHTML = '<i class="fa-solid fa-bell-slash" style="color:#fec24f;margin-right:6px"></i><strong>0 push subscribers registered.</strong> Investors must open the app, go to <em>Profile → Notifications</em>, and enable push notifications before they can receive them.';
      warnEl.style.display = 'block';
    } else if (subCount > 0) {
      warnEl.innerHTML = `<i class="fa-solid fa-bell" style="color:#fec24f;margin-right:6px"></i>${subCount} push subscriber${subCount !== 1 ? 's' : ''} registered.`;
      warnEl.style.display = 'block';
    }
  } else if (warnEl) {
    warnEl.style.display = 'none';
  }
}

async function updateBroadcastPreview() {
  const seg = document.getElementById('broadcastSegment')?.value || 'all';
  const countEl = document.getElementById('broadcastPreviewCount');
  if (countEl) countEl.textContent = '…';
  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res = await fetch(`/api/admin/broadcast/preview?segment=${encodeURIComponent(seg)}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      if (countEl) countEl.textContent = data.count ?? '—';
    } else {
      if (countEl) countEl.textContent = '—';
    }
  } catch (_) {
    if (countEl) countEl.textContent = '—';
  }
}

async function sendBroadcast() {
  const channel  = document.querySelector('input[name="broadcastChannel"]:checked')?.value || 'email';
  const segment  = document.getElementById('broadcastSegment')?.value || 'all';
  const subject  = document.getElementById('broadcastSubject')?.value?.trim() || '';
  const message  = document.getElementById('broadcastMessage')?.value?.trim() || '';

  if (!message) { Toast.error('Please write a message before sending'); return; }
  if (channel !== 'sms' && channel !== 'push' && !subject) {
    Toast.error('Please enter a subject / push title');
    return;
  }

  const segLabel     = document.getElementById('broadcastSegment')?.selectedOptions[0]?.text || segment;
  const previewCount = document.getElementById('broadcastPreviewCount')?.textContent || '?';
  const chLabel      = { email: 'EMAIL', sms: 'SMS', push: 'PUSH NOTIFICATION', both: 'EMAIL + SMS', all: 'ALL CHANNELS' }[channel] || channel.toUpperCase();

  if (!await Confirm.ask(`Send ${chLabel} broadcast?`, { body: `To ${previewCount} recipients in "${segLabel}". Subject: "${subject || '(no subject)'}". This cannot be undone.`, confirmLabel: 'Send Broadcast' })) return;

  const btn = document.getElementById('broadcastSendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…'; }

  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';

    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ subject, message, channel, segment }),
    });

    const data = await res.json();
    if (!res.ok) {
      Toast.error(data.error || 'Broadcast failed');
      return;
    }

    const { sent = 0, failed = 0, total = 0, pushSubscribers } = data;
    const isPushChannel = channel === 'push' || channel === 'all';
    if (isPushChannel && sent === 0 && pushSubscribers === 0) {
      Toast.info('No push subscribers registered yet. Investors must enable notifications in their profile settings first.');
    } else if (isPushChannel && sent === 0 && total > 0) {
      Toast.info(`Push sent but 0 delivered — ${pushSubscribers || 0} subscriber(s) registered, none matched the selected segment. Ask investors to re-enable notifications in their profile.`);
    } else if (isPushChannel && sent > 0) {
      Toast.success(`Push notification delivered to ${sent} subscriber${sent !== 1 ? 's' : ''}!`);
    } else {
      Toast.success(`Broadcast sent! ${sent} of ${total} delivered${failed > 0 ? ` (${failed} failed)` : ''}`);
    }

    // Record in history
    _broadcastHistory.unshift({
      date:    new Date().toISOString(),
      subject: subject || '(SMS/Push)',
      message: message.slice(0, 80) + (message.length > 80 ? '…' : ''),
      channel,
      segment: segLabel,
      sent,
      failed,
      total,
    });
    _renderBroadcastHistory();

    // Refresh push analytics if push was involved
    if (channel === 'push' || channel === 'all') loadPushAnalytics();

    // Clear form
    const msgEl = document.getElementById('broadcastMessage');
    const subEl = document.getElementById('broadcastSubject');
    if (msgEl) msgEl.value = '';
    if (subEl) subEl.value = '';
    updateBroadcastPreview();
  } catch (err) {
    Toast.error('Broadcast failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Broadcast'; }
  }
}

function _renderBroadcastHistory() {
  const body  = document.getElementById('broadcastHistoryBody');
  const count = document.getElementById('broadcastHistoryCount');
  if (count) count.textContent = `${_broadcastHistory.length} broadcast${_broadcastHistory.length !== 1 ? 's' : ''}`;

  if (!body) return;
  if (!_broadcastHistory.length) {
    body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-dim)">
      <i class="fa-solid fa-inbox" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:8px"></i>
      No broadcasts sent yet
    </div>`;
    return;
  }

  const chIcon = { email: 'fa-envelope', sms: 'fa-mobile-screen', push: 'fa-bell', both: 'fa-paper-plane', all: 'fa-paper-plane' };

  body.innerHTML = _broadcastHistory.map(h => `
    <div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:0.82rem;font-weight:700;color:var(--text)">${h.subject || '(SMS)'}</span>
        <span style="font-size:0.7rem;color:var(--text-dim)">${Utils.date(h.date)}</span>
      </div>
      <div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:6px">${h.message}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="badge badge--blue"><i class="fa-solid ${chIcon[h.channel] || 'fa-paper-plane'}"></i> ${h.channel}</span>
        <span class="badge badge--gray">${h.segment}</span>
        <span class="badge badge--green"><i class="fa-solid fa-check"></i> ${h.sent} sent</span>
        ${h.failed > 0 ? `<span class="badge badge--red"><i class="fa-solid fa-xmark"></i> ${h.failed} failed</span>` : ''}
      </div>
    </div>
  `).join('');
}

/* ─── Push Analytics ─── */
async function loadPushAnalytics() {
  const subEl  = document.getElementById('pushStatSubscribers');
  const sentEl = document.getElementById('pushStatSent');
  const logEl  = document.getElementById('pushRecentLog');
  if (!subEl && !sentEl && !logEl) return; // not on comms view

  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res   = await fetch('/api/push/analytics', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!res.ok) {
      if (logEl) logEl.textContent = 'Could not load push analytics.';
      return;
    }

    const data = await res.json();
    if (subEl)  subEl.textContent  = data.total_subscribers ?? 0;
    if (sentEl) sentEl.textContent = data.notifications_sent ?? 0;
    // Refresh push channel warning banner with updated count
    const channel = document.querySelector('input[name="broadcastChannel"]:checked')?.value;
    if (channel === 'push' || channel === 'all') toggleBroadcastSubject();

    const recent = data.recent_notifications || [];
    if (!logEl) return;

    if (!recent.length) {
      logEl.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-dim)">No notifications sent yet</div>';
      return;
    }

    const dateStr = d => new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
    logEl.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.76rem;min-width:400px">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 6px;color:var(--text-muted)">Date</th>
          <th style="text-align:left;padding:4px 6px;color:var(--text-muted)">Title</th>
          <th style="text-align:left;padding:4px 6px;color:var(--text-muted)">Body</th>
          <th style="text-align:right;padding:4px 6px;color:var(--text-muted)">Recipients</th>
          <th style="text-align:left;padding:4px 6px;color:var(--text-muted)">Type</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map(n => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:4px 6px;color:var(--text-dim);white-space:nowrap">${dateStr(n.created_at)}</td>
            <td style="padding:4px 6px;font-weight:600">${_esc(n.title) || '—'}</td>
            <td style="padding:4px 6px;color:var(--text-muted)">${_esc((n.body || '').slice(0, 50))}${(n.body || '').length > 50 ? '…' : ''}</td>
            <td style="padding:4px 6px;text-align:right">${n.recipient_count ?? 0}</td>
            <td style="padding:4px 6px"><span class="badge badge--blue">${_esc(n.notification_type) || 'system'}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table></div>`;
  } catch (err) {
    if (logEl) logEl.textContent = 'Error loading analytics: ' + err.message;
    console.error('[push analytics]', err);
  }
}

async function openPushSubscribersModal() {
  Modal.open('pushSubscribersModal');
  const body = document.getElementById('pushSubscribersBody');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res = await fetch('/api/push/subscribers', {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const { data = [] } = await res.json();
    if (!data.length) {
      body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-dim)">No push subscribers yet.</div>';
      return;
    }
    const dateStr = d => d ? new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    body.innerHTML = `
      <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">${data.length} subscriber${data.length !== 1 ? 's' : ''}</div>
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:500">Name</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:500">Email</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:500">Channel</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-muted);font-weight:500">Since</th>
          </tr>
        </thead>
        <tbody>
          ${data.map(s => `
            <tr style="border-bottom:1px solid var(--border)">
              <td style="padding:7px 8px;font-weight:500">${_esc(s.first_name)} ${_esc(s.last_name)}</td>
              <td style="padding:7px 8px;color:var(--text-muted)">${_esc(s.email || '—')}</td>
              <td style="padding:7px 8px"><span class="badge ${s.channel === 'mobile' ? 'badge--blue' : 'badge--green'}">${_esc(s.channel)}</span></td>
              <td style="padding:7px 8px;color:var(--text-dim);white-space:nowrap">${dateStr(s.subscribed_at)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    body.innerHTML = `<div style="color:var(--danger);padding:12px">Failed to load subscribers: ${_esc(err.message)}</div>`;
  }
}

/* ═══════════════════════════════════════════════
   NAV / AUM REPORT EXPORT (Feature 11)
   ═══════════════════════════════════════════════ */
async function exportAumReport() {
  // Ensure we have data
  if (!STATE.investors.length) {
    Toast.info('Loading investor data…');
    try {
      const [invRes, poolRes, invstRes] = await Promise.all([
        API.investors.list({ limit: 200 }),
        API.pools.list({ limit: 100 }),
        API.investments.list({ limit: 200 }),
      ]);
      STATE.investors   = invRes.data   || [];
      STATE.pools       = poolRes.data  || [];
      STATE.investments = invstRes.data || [];
    } catch (e) {
      Toast.error('Failed to load data for export');
      return;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Aggregate totals — from live tables
  const totalWallet   = STATE.investors.reduce((s, i) => s + (parseFloat(i.wallet_balance) || 0), 0);
  const totalInvested = STATE.investments.filter(i => i.status === 'active').reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const totalReturns  = STATE.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const activeInvCount = STATE.investments.filter(i => i.status === 'active').length;
  const totalAUM      = totalWallet + totalInvested;

  const fmt  = v => 'R' + Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtD = v => v ? new Date(v).toLocaleDateString('en-ZA') : '';

  // Build rows
  const rows = [];

  // Section 1: Summary
  rows.push(['SV Capital — AUM Report', `Generated: ${now}`]);
  rows.push(['', '']);
  rows.push(['Total AUM', fmt(totalAUM)]);
  rows.push(['Total Investors', STATE.investors.length]);
  rows.push(['Active Investments', activeInvCount]);
  rows.push(['Total Returns Paid', fmt(totalReturns)]);
  rows.push(['', '']);

  // Section 2: Investor detail
  rows.push([
    'Investor ID', 'Name', 'Email', 'Wallet Balance', 'Total Invested',
    'Total Returns', 'Active Investments', 'FICA Status', 'KYC Status', 'Date Joined'
  ]);

  STATE.investors.forEach(inv => {
    const activeInvts = STATE.investments.filter(i => i.investor_id === inv.id && i.status === 'active').length;
    rows.push([
      inv.id || '',
      `${inv.first_name || ''} ${inv.last_name || ''}`.trim(),
      inv.email || '',
      fmt(inv.wallet_balance),
      fmt(inv.total_invested),
      fmt(inv.total_returns),
      activeInvts,
      inv.fica_status || '',
      inv.kyc_status  || '',
      fmtD(inv.date_joined),
    ]);
  });

  _downloadCSV(rows, `SVC-AUM-Report-${today}.csv`);
  Toast.success(`AUM report exported — ${STATE.investors.length} investors`);

  // Optionally generate PDF if jsPDF is available
  if (window.jspdf) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(18);
      doc.text('SV Capital — AUM Report', 14, 18);
      doc.setFontSize(10);
      doc.text(`Generated: ${now}`, 14, 26);
      doc.text(`Total AUM: ${fmt(totalAUM)}`, 14, 34);
      doc.text(`Total Investors: ${STATE.investors.length}`, 14, 40);
      doc.text(`Active Investments: ${activeInvCount}`, 14, 46);
      doc.text(`Total Returns Paid: ${fmt(totalReturns)}`, 14, 52);
      doc.save(`SVC-AUM-Report-${today}.pdf`);
      Toast.success('PDF report also exported');
    } catch (_) { /* jsPDF not fully available */ }
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 1: AML COMPLIANCE DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadAML() {
  try {
    const [flagRes, invRes] = await Promise.all([
      API._fetch('GET', 'tables/support_tickets', null, { category: 'aml_review', limit: 200 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 })
    ]);
    STATE.amlFlags = flagRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderAMLStats();
    renderAMLTable();

    // Update nav badge
    const badge = document.getElementById('amlBadge');
    const openCount = STATE.amlFlags.filter(f => f.status === 'open' || f.status === 'in_review').length;
    if (badge) {
      badge.textContent = openCount;
      badge.style.display = openCount > 0 ? '' : 'none';
    }
  } catch (e) {
    Toast.error('Failed to load AML flags');
    console.error(e);
  }
}

function renderAMLStats() {
  const flags = STATE.amlFlags;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const total      = flags.length;
  const open       = flags.filter(f => f.status === 'open' || f.status === 'in_review').length;
  const highPri    = flags.filter(f => f.priority === 'high' || f.priority === 'urgent').length;
  const resolvedMo = flags.filter(f => f.status === 'resolved' && new Date(f.updated_at || f.resolved_at || f.created_at) >= startOfMonth).length;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('aml-total',    total);
  set('aml-open',     open);
  set('aml-high',     highPri);
  set('aml-resolved', resolvedMo);
}

function renderAMLTable() {
  const tbody = document.getElementById('amlTableBody');
  if (!tbody) return;
  const flags = STATE.amlFlags;

  if (!flags.length) {
    tbody.innerHTML = _emptyRow('fa-shield-check', 'No AML flags', 'All investors are within normal risk thresholds.', 7);
    return;
  }

  const statusBadge = s => {
    const map = { open: 'badge--red', in_review: 'badge--yellow', resolved: 'badge--green', closed: 'badge--gray' };
    return `<span class="badge ${map[s] || 'badge--gray'}">${s ? s.replace(/_/g, ' ') : '—'}</span>`;
  };

  tbody.innerHTML = flags.map(f => {
    const inv      = STATE.investors.find(i => i.id === f.investor_id);
    const invName  = f.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : f.investor_id || '—');
    const amount   = f.amount || f.transaction_amount || '';
    const canResolve = f.status !== 'resolved' && f.status !== 'closed';
    return `<tr>
      <td class="td-muted clip">${Utils.date(f.created_at)}</td>
      <td>
        <div class="td-strong clip">${invName}</div>
        <div class="td-muted clip" style="font-size:0.72rem">${f.investor_id || ''}</div>
      </td>
      <td class="td-gold fw-700 clip">${amount ? Utils.rand(amount) : '—'}</td>
      <td class="clip" style="font-size:0.8rem">${f.subject || f.reason || f.message || '—'}</td>
      <td>${Utils.priorityBadge ? Utils.priorityBadge(f.priority) : `<span class="badge">${f.priority || '—'}</span>`}</td>
      <td>${statusBadge(f.status)}</td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--secondary btn--sm" onclick='navigate("investors", document.querySelector("[data-view=investors]"));setTimeout(()=>{document.getElementById("investorSearch").value=${JSON.stringify(invName)};document.getElementById("investorSearch").dispatchEvent(new Event("input"))},350)'><i class="fa-solid fa-eye"></i> Investor</button>
          ${canResolve ? `<button class="btn btn--success btn--sm" onclick='resolveAMLFlag(${JSON.stringify(f.id)})'><i class="fa-solid fa-check"></i> Resolve</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function resolveAMLFlag(id) {
  const flag = STATE.amlFlags.find(f => f.id === id);
  const investorName = _esc(flag?.investor_name || 'this investor');
  Modal.openInline(`
    <div class="modal__header"><span class="modal__title">Resolve AML Flag</span><button class="modal__close" onclick="Modal.close('_inlineModal')"><i class="fa-solid fa-xmark"></i></button></div>
    <div class="modal__body">
      <p style="margin:0 0 14px;font-size:0.9rem;color:var(--text-muted)">Resolving AML flag for <strong style="color:var(--text)">${investorName}</strong>.</p>
      <div class="form-group">
        <label class="form-label">Resolution Notes (optional)</label>
        <textarea class="form-input" id="_amlResolveNote" rows="3" placeholder="e.g. Documents verified, no suspicious activity found…"></textarea>
      </div>
    </div>
    <div class="modal__footer">
      <button class="btn btn--secondary" onclick="Modal.close('_inlineModal')">Cancel</button>
      <button class="btn btn--success" onclick="_confirmResolveAML(${JSON.stringify(id)})"><i class="fa-solid fa-check"></i> Resolve</button>
    </div>`);
}

async function _confirmResolveAML(id) {
  const note = document.getElementById('_amlResolveNote')?.value?.trim() || '';
  const adminResponse = note
    ? `Resolved by admin on ${new Date().toLocaleDateString('en-ZA')}: ${note}`
    : `Resolved by admin on ${new Date().toLocaleDateString('en-ZA')}`;
  Modal.close('_inlineModal');
  try {
    await API._fetch('PATCH', `tables/support_tickets/${id}`, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      admin_response: adminResponse,
    });
    Toast.success('AML flag resolved');
    await loadAML();
  } catch (e) { Toast.error('Failed to resolve AML flag'); }
}

/* ═══════════════════════════════════════════════
   FEATURE 2: INVESTOR NOTES
   ═══════════════════════════════════════════════ */
async function loadInvestorNotes(investorId) {
  const listEl  = document.getElementById('invNotesList');
  const countEl = document.getElementById('invNotesCount');
  if (!listEl) return;

  const renderNotes = (notes) => {
    if (countEl) countEl.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;
    if (!notes.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem">No notes yet — add the first note below.</div>';
      return;
    }
    listEl.innerHTML = notes.map(n => {
      const authorShort = (n.admin_email || n.author || 'Admin').replace(/@.*$/, '');
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:0.75rem;font-weight:700;color:var(--orange)">${authorShort}</span>
          <span style="font-size:0.7rem;color:var(--text-dim)">${Utils.date(n.created_at || n.date)}</span>
        </div>
        <div style="font-size:0.82rem;color:var(--text);white-space:pre-wrap">${n.note || n.text || '—'}</div>
      </div>`;
    }).join('');
  };

  try {
    const res = await API._fetch('GET', 'tables/investor_notes', null, { investor_id: investorId, limit: 50 });
    const notes = (res.data || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    renderNotes(notes);
  } catch (_) {
    // investor_notes table not available — read from investor.notes field
    const inv = STATE.investors.find(i => i.id === investorId);
    const raw = inv?.notes || '';
    if (!raw || raw.startsWith('{')) {
      // Either empty or contains bank JSON — show empty state
      renderNotes([]);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) { renderNotes(parsed); return; }
    } catch (_2) {}
    // Plain text stored in notes field — show as single entry
    renderNotes([{ note: raw, admin_email: 'system', created_at: inv?.created_at }]);
  }
}

async function addInvestorNote(investorId) {
  const ta = document.getElementById('invNewNoteTA');
  if (!ta) return;
  const noteText = ta.value.trim();
  if (!noteText) { Toast.error('Please enter a note'); return; }
  const adminEmail = _getAdminName();

  const saveBtn = document.querySelector(`button[onclick*="addInvestorNote"]`);
  if (saveBtn) saveBtn.disabled = true;
  try {
    await API._fetch('POST', 'tables/investor_notes', {
      id:          `NOTE-${Date.now()}`,
      investor_id: investorId,
      admin_email: adminEmail,
      note:        noteText,
      created_at:  new Date().toISOString()
    });
    ta.value = '';
    Toast.success('Note added');
    await loadInvestorNotes(investorId);
  } catch (_) {
    // Fallback: store as JSON array in investor.notes field
    try {
      const inv = STATE.investors.find(i => i.id === investorId);
      const raw = inv?.notes || '';
      let existing = [];
      // Only try to parse if it's NOT bank JSON (bank JSON starts with '{')
      if (raw && !raw.startsWith('{')) {
        try { const p = JSON.parse(raw); if (Array.isArray(p)) existing = p; } catch (_2) {}
      }
      existing.unshift({ note: noteText, admin_email: adminEmail, created_at: new Date().toISOString() });
      const newVal = JSON.stringify(existing);
      await API._fetch('PATCH', `tables/investors/${investorId}`, { notes: newVal });
      if (inv) inv.notes = newVal;
      ta.value = '';
      Toast.success('Note saved');
      await loadInvestorNotes(investorId);
    } catch (e2) {
      Toast.error('Failed to save note: ' + (e2.message || 'unknown error'));
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════
   FEATURE: INVESTOR ACTIVITY TIMELINE
   ═══════════════════════════════════════════════ */

function _timelineItem(icon, colorHex, text, date) {
  // Convert hex to rgb for background tint
  const hexToRgb = h => {
    const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
    return `${r},${g},${b}`;
  };
  const rgb = hexToRgb(colorHex.replace('#','').length === 6 ? colorHex : '#7a92a8');
  return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
    <div style="width:28px;height:28px;border-radius:50%;background:rgba(${rgb},0.12);border:1px solid rgba(${rgb},0.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
      <i class="fa-solid ${icon}" style="font-size:0.7rem;color:${colorHex}"></i>
    </div>
    <div style="flex:1">
      <div style="font-size:0.82rem;font-weight:600;color:var(--text)">${text}</div>
      <div style="font-size:0.7rem;color:#6b7280">${Utils.date(date)}</div>
    </div>
  </div>`;
}

function _buildTimelineEvents(inv, invsts, txns) {
  const events = [];

  // 1. Account created
  if (inv.date_joined) {
    events.push({ date: inv.date_joined, icon: 'fa-user-plus', color: '#656565', text: 'Account created' });
  }

  // 2. Transactions
  txns.forEach(t => {
    const amt = Utils.rand(Math.abs(t.amount || 0));
    const d = t.created_at || t.transaction_date;
    if (!d) return;
    const typeMap = {
      deposit:    { icon: 'fa-arrow-down',           color: '#22c55e', text: `Deposited ${amt}` },
      investment: { icon: 'fa-chart-line',            color: '#fec24f', text: `Invested ${amt}${t.description ? ' in ' + t.description : ''}` },
      return:     { icon: 'fa-coins',                 color: '#22c55e', text: `Interest earned ${amt}` },
      payout:     { icon: 'fa-arrow-up',              color: '#656565', text: `Payout received ${amt}` },
      withdrawal: { icon: 'fa-arrow-up-from-bracket', color: '#f97316', text: `Withdrawal ${amt}${t.status ? ' (' + t.status + ')' : ''}` },
      adjustment: { icon: 'fa-sliders',               color: '#7a92a8', text: `Manual adjustment ${amt}` },
    };
    const m = typeMap[t.type];
    if (m) events.push({ date: d, icon: m.icon, color: m.color, text: m.text });
  });

  // 3. Investments
  invsts.forEach(i => {
    const poolLabel = i.pool_name || i.pool_id || 'Pool';
    const amt = Utils.rand(i.amount || 0);
    const rate = i.annual_rate ? ` at ${Utils.pct(i.annual_rate)}` : '';
    if (i.start_date || i.investment_date) {
      events.push({ date: i.start_date || i.investment_date, icon: 'fa-seedling', color: '#fec24f', text: `Investment started — ${poolLabel} ${amt}${rate}` });
    }
    if (i.status === 'matured' && i.end_date) {
      events.push({ date: i.end_date, icon: 'fa-clock', color: '#f97316', text: `Investment matured — ${poolLabel}` });
    }
    if (i.status === 'paid_out' && i.payout_date) {
      events.push({ date: i.payout_date, icon: 'fa-check-circle', color: '#22c55e', text: `Investment matured — ${poolLabel}` });
    }
  });

  return events;
}

function _renderTimeline(containerId, events) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!events.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.82rem">No timeline events found</div>';
    return;
  }
  const sorted = [...events].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(e => _timelineItem(e.icon, e.color, e.text, e.date)).join('');
}

function loadInvestorTimeline(inv, invsts, txns) {
  const el = document.getElementById('investorTimeline');
  if (!el) return;

  const events = [];

  // Join date
  if (inv.date_joined) events.push({
    date: new Date(inv.date_joined), icon: 'fa-user-plus', color: '#22c55e',
    title: 'Account created', sub: `Joined SV Capital`
  });

  // KYC status change
  if (inv.kyc_status === 'approved') events.push({
    date: new Date(inv.updated_at || inv.date_joined || Date.now()), icon: 'fa-shield-check', color: '#22c55e',
    title: 'KYC Approved', sub: 'FICA verification completed'
  });

  // Investments
  invsts.forEach(i => {
    events.push({
      date: new Date(i.start_date || i.created_at), icon: 'fa-chart-line', color: '#fec24f',
      title: `Investment: ${Utils.rand(i.amount)}`,
      sub: `${i.pool_name || i.product_type} · ${Utils.statusBadge(i.status)}`
    });
    if (i.status === 'matured' && i.end_date) events.push({
      date: new Date(i.end_date), icon: 'fa-hourglass-end', color: '#eda5ff',
      title: `Investment matured`, sub: `${i.pool_name || '—'} · ${Utils.rand(i.amount)}`
    });
  });

  // Transactions
  txns.forEach(t => {
    const icons = { deposit: 'fa-wallet', withdrawal: 'fa-arrow-up-from-bracket', investment: 'fa-chart-line', return: 'fa-star', payout: 'fa-money-bill-transfer', fee: 'fa-receipt' };
    const colors = { deposit: '#22c55e', withdrawal: '#ef4444', investment: '#fec24f', return: '#656565', payout: '#22c55e', fee: '#fec24f' };
    events.push({
      date: new Date(t.transaction_date || t.created_at), icon: icons[t.type] || 'fa-arrows-rotate',
      color: colors[t.type] || '#888',
      title: `${(t.type||'').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())}: ${Utils.rand(Math.abs(t.amount))}`,
      sub: `${t.status} · Ref: ${t.reference||'—'}`
    });
  });

  events.sort((a, b) => b.date - a.date);

  if (!events.length) {
    el.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:0.8rem">No activity recorded yet</div>';
    return;
  }

  el.innerHTML = events.map((e, idx) => `
    <div style="display:flex;gap:12px;padding:8px 0;${idx < events.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
      <div style="width:28px;height:28px;border-radius:50%;background:${e.color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
        <i class="fa-solid ${e.icon}" style="color:${e.color};font-size:0.7rem"></i>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.8rem;font-weight:700;color:var(--text)">${e.title}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">${e.sub}</div>
        <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">${Utils.date(e.date)}</div>
      </div>
    </div>
  `).join('');
}

/* ═══════════════════════════════════════════════
   ACTIVITY TAB
   ═══════════════════════════════════════════════ */

async function _loadInvestorActivity(investorId) {
  const accessEl  = document.getElementById('invActivity-access');
  const devicesEl = document.getElementById('invActivity-devices');
  const sessEl    = document.getElementById('invActivity-sessions');
  const devCnt    = document.getElementById('invActivity-deviceCount');
  const sesCnt    = document.getElementById('invActivity-sessionCount');

  if (!accessEl) return;

  const spin = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
  [accessEl, devicesEl, sessEl].forEach(el => { if (el) el.innerHTML = spin; });

  let data;
  try {
    const r = await fetch(`/api/tables/investors/${investorId}/activity`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    const err = `<div style="text-align:center;padding:16px;color:#ef4444;font-size:0.8rem">Failed to load activity</div>`;
    [accessEl, devicesEl, sessEl].forEach(el => { if (el) el.innerHTML = err; });
    return;
  }

  const { user, devices, sessions } = data;

  // ── Account Access ──────────────────────────────────────
  if (accessEl) {
    const rows = [
      ['Last Login',      user?.last_login  ? Utils.datetime(user.last_login) : '<span style="color:var(--text-dim)">Never</span>'],
      ['Account Created', user?.created_at  ? Utils.datetime(user.created_at) : '—'],
      ['2FA Enabled',     user?.totp_enabled
        ? '<span style="color:#22c55e;font-weight:700"><i class="fa-solid fa-shield-check"></i> Yes</span>'
        : '<span style="color:var(--text-dim)"><i class="fa-solid fa-shield-xmark"></i> No</span>'],
      ['Account Status',  user?.is_active === false
        ? '<span style="color:#ef4444;font-weight:700">Suspended</span>'
        : '<span style="color:#22c55e;font-weight:700">Active</span>'],
      ['Portal Role',     user?.role ? `<span style="text-transform:capitalize">${_esc(user.role)}</span>` : '—'],
    ];
    accessEl.innerHTML = rows.map(([label, val]) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:0.82rem">
        <span style="color:var(--text-muted);min-width:120px">${label}</span>
        <span style="font-weight:500;text-align:right">${val}</span>
      </div>`).join('');
  }

  // ── Devices ─────────────────────────────────────────────
  if (devicesEl) {
    if (devCnt) devCnt.textContent = devices.length ? `${devices.length} device${devices.length > 1 ? 's' : ''}` : 'No devices';
    if (!devices.length) {
      devicesEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:0.82rem"><i class="fa-solid fa-mobile-screen" style="font-size:1.4rem;margin-bottom:8px;display:block;opacity:0.3"></i>App not yet downloaded</div>';
    } else {
      devicesEl.innerHTML = devices.map(d => {
        const platIcon = d.platform === 'ios' ? 'fa-apple' : d.platform === 'android' ? 'fa-android' : 'fa-globe';
        const platColor = d.platform === 'ios' ? '#888' : d.platform === 'android' ? '#22c55e' : '#eda5ff';
        return `
        <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="width:36px;height:36px;border-radius:10px;background:${platColor}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fa-brands ${platIcon}" style="color:${platColor};font-size:1.1rem"></i>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:0.82rem;font-weight:700;color:var(--text)">${_esc(d.device_name || (d.platform === 'ios' ? 'iPhone / iPad' : d.platform === 'android' ? 'Android Device' : 'Web Browser'))}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">Version: ${_esc(d.app_version || 'Unknown')} · ${(d.platform||'').toUpperCase()}</div>
            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">First registered: ${Utils.date(d.created_at)} · Last active: ${Utils.date(d.updated_at)}</div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Sessions ─────────────────────────────────────────────
  if (sessEl) {
    if (sesCnt) sesCnt.textContent = sessions.length ? `${sessions.length} active` : 'None';
    if (!sessions.length) {
      sessEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:0.82rem"><i class="fa-solid fa-circle-xmark" style="font-size:1.4rem;margin-bottom:8px;display:block;opacity:0.3"></i>No active sessions</div>';
    } else {
      sessEl.innerHTML = sessions.map(s => {
        const ua = s.user_agent || '';
        let browser = 'Unknown browser';
        if (/Edg\//i.test(ua))         browser = 'Edge';
        else if (/Chrome\//i.test(ua)) browser = 'Chrome';
        else if (/Firefox\//i.test(ua)) browser = 'Firefox';
        else if (/Safari\//i.test(ua))  browser = 'Safari';
        let os = '';
        if (/iPhone|iPad/i.test(ua))    os = 'iOS';
        else if (/Android/i.test(ua))   os = 'Android';
        else if (/Windows/i.test(ua))   os = 'Windows';
        else if (/Mac OS/i.test(ua))    os = 'macOS';
        else if (/Linux/i.test(ua))     os = 'Linux';
        const deviceLabel = os ? `${browser} · ${os}` : browser;
        const isRecent = s.last_used_at && (Date.now() - new Date(s.last_used_at).getTime()) < 5 * 60 * 1000;
        return `
        <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="width:36px;height:36px;border-radius:10px;background:var(--surface-2,#f3f4f6);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fa-solid fa-computer" style="color:var(--text-muted);font-size:1rem"></i>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:0.82rem;font-weight:700;color:var(--text)">${_esc(deviceLabel)}</span>
              ${isRecent ? '<span style="font-size:0.65rem;background:#22c55e22;color:#22c55e;padding:1px 6px;border-radius:20px;font-weight:700">ONLINE</span>' : ''}
            </div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">IP: ${_esc(s.ip_address || 'Unknown')}</div>
            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">Started: ${Utils.datetime(s.created_at)} · Last active: ${Utils.datetime(s.last_used_at)}</div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 3: ANALYTICS CHARTS (Real Data)
   ═══════════════════════════════════════════════ */

// Helper: get last N month labels (e.g. ["Jul 25", "Aug 25", ...])
function _lastNMonths(n) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const result = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ label: `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, year: d.getFullYear(), month: d.getMonth() });
  }
  return result;
}

function _chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 8 } },
      tooltip: { backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8', borderColor: 'rgba(254,194,79,0.3)', borderWidth: 1 }
    },
    scales: {
      x: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', font: { size: 10 } } },
      y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#3d5268', font: { size: 10 } } }
    }
  };
}

function renderAnAumChart() {
  const ctx = document.getElementById('anAumChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  // Running cumulative sum of deposit transactions
  const monthTotals = buckets.map(b => {
    return STATE.transactions
      .filter(t => {
        if (t.type !== 'deposit' || t.status !== 'completed') return false;
        const d = new Date(t.created_at || t.transaction_date || 0);
        return d.getFullYear() === b.year && d.getMonth() === b.month;
      })
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  });

  // Running cumulative AUM
  let running = 0;
  const aumData = monthTotals.map(v => { running += v; return running; });

  if (STATE.charts.anAum) STATE.charts.anAum.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${Utils.rand(c.parsed.y)}` };
  opts.scales.y.ticks.callback = v => 'R' + (v / 1000).toFixed(0) + 'k';

  STATE.charts.anAum = new Chart(ctx, {
    type: 'line',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Cumulative AUM (deposits)',
        data: aumData,
        borderColor: '#fec24f',
        backgroundColor: (c) => {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, 'rgba(254,194,79,0.2)');
          g.addColorStop(1, 'rgba(254,194,79,0)');
          return g;
        },
        fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: '#fec24f'
      }]
    },
    options: opts
  });
}

function renderAnNewInvChart() {
  const ctx = document.getElementById('anNewInvChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  const counts = buckets.map(b =>
    STATE.investors.filter(i => {
      const d = new Date(i.date_joined || i.created_at || 0);
      return d.getFullYear() === b.year && d.getMonth() === b.month;
    }).length
  );

  if (STATE.charts.anNewInv) STATE.charts.anNewInv.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${c.parsed.y} investors` };

  STATE.charts.anNewInv = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'New Investors',
        data: counts,
        backgroundColor: 'rgba(101,101,101,0.7)',
        borderRadius: 5
      }]
    },
    options: opts
  });
}

function renderAnReturnsChart() {
  const ctx = document.getElementById('anReturnsChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  const data = buckets.map(b =>
    STATE.transactions
      .filter(t => {
        if (t.type !== 'return') return false;
        const d = new Date(t.created_at || t.transaction_date || 0);
        return d.getFullYear() === b.year && d.getMonth() === b.month;
      })
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0)
  );

  if (STATE.charts.anReturns) STATE.charts.anReturns.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${Utils.rand(c.parsed.y)}` };
  opts.scales.y.ticks.callback = v => 'R' + (v / 1000).toFixed(0) + 'k';

  STATE.charts.anReturns = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Returns Distributed',
        data,
        backgroundColor: 'rgba(34,197,94,0.7)',
        borderRadius: 5
      }]
    },
    options: opts
  });
}

function renderAnStatusChart() {
  const ctx = document.getElementById('anStatusChart');
  if (!ctx) return;

  const statuses = ['active', 'matured', 'paid_out', 'pending'];
  const counts = statuses.map(s => STATE.investments.filter(i => i.status === s).length);
  const labels = ['Active', 'Matured', 'Paid Out', 'Pending'];
  const colors = ['#22c55e', '#eda5ff', '#fec24f', '#f97316'];

  if (STATE.charts.anStatus) STATE.charts.anStatus.destroy();

  STATE.charts.anStatus = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } },
        tooltip: { backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8', callbacks: { label: c => ` ${c.label}: ${c.parsed}` } }
      }
    }
  });
}

// Chart rendering triggered from loadAnalytics after data loads
function _renderAnalyticsCharts() {
  renderAnAumChart();
  renderAnNewInvChart();
  renderAnReturnsChart();
  renderAnStatusChart();
}

/* ═══════════════════════════════════════════════
   FEATURE 4: MANUAL INTEREST / ADJUSTMENT
   ═══════════════════════════════════════════════ */
function openManualAdjModal() {
  const sel = document.getElementById('adjInvestorSelect');
  if (sel) {
    sel.innerHTML = '<option value="">Select investor…</option>' +
      [...STATE.investors]
        .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
        .map(i => `<option value="${i.id}">${i.first_name} ${i.last_name} (${i.id})</option>`)
        .join('');
  }
  const refEl = document.getElementById('adjReference');
  if (refEl) refEl.value = `ADJ-${Date.now()}`;
  const amtEl = document.getElementById('adjAmount');
  if (amtEl) amtEl.value = '';
  const descEl = document.getElementById('adjDescription');
  if (descEl) descEl.value = '';
  // Default to credit
  const creditRad = document.getElementById('adjCredit');
  if (creditRad) creditRad.checked = true;
  Modal.open('manualAdjModal');
}

async function saveManualAdj(btn) {
  const investorId  = document.getElementById('adjInvestorSelect').value;
  const adjType     = document.querySelector('input[name="adjType"]:checked')?.value || 'credit';
  const rawAmount   = parseFloat(document.getElementById('adjAmount').value);
  const description = document.getElementById('adjDescription').value.trim();
  const reference   = document.getElementById('adjReference').value.trim();

  if (!investorId) { Toast.error('Please select an investor'); return; }
  if (!rawAmount || rawAmount <= 0) { Toast.error('Please enter a valid positive amount'); return; }
  if (!description) { Toast.error('Description is required'); return; }

  const investor = STATE.investors.find(i => i.id === investorId);
  if (!investor) { Toast.error('Investor not found'); return; }

  const signedAmount = adjType === 'credit' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
  const currentBalance = parseFloat(investor.wallet_balance) || 0;
  const newBalance = Math.round((currentBalance + signedAmount) * 100) / 100;

  if (newBalance < 0 && adjType === 'debit') {
    if (!await Confirm.ask(`Negative balance warning`, { body: `This debit of ${Utils.rand(rawAmount)} will result in a negative wallet balance of ${Utils.rand(newBalance)}. Continue?`, confirmLabel: 'Continue' })) return;
  }

  await _withBtn(btn, async () => {
    try {
      await API.transactions.create({
        id:               Utils.genId ? Utils.genId('TXN') : `TXN-${Date.now()}`,
        investor_id:      investorId,
        type:             'adjustment',
        amount:           signedAmount,
        status:           'completed',
        reference:        reference,
        description:      description,
        transaction_date: new Date().toISOString()
      });
      await API.investors.update(investorId, { wallet_balance: newBalance });
      investor.wallet_balance = newBalance;
      Toast.success(`Adjustment applied: ${adjType === 'credit' ? '+' : '−'}${Utils.rand(rawAmount)} for ${investor.first_name} ${investor.last_name}`);
      Modal.close('manualAdjModal');
      if (STATE.currentView === 'investors') await loadInvestors();
    } catch (e) {
      Toast.error('Failed to apply adjustment: ' + (e.message || 'unknown error'));
      console.error('[saveManualAdj]', e);
    }
  });
}

/* ════════════════════════════════════════════
   DATA MIGRATION
════════════════════════════════════════════ */
async function runMigration() {
  const fileMap = {
    users: 'mig-users', pools: 'mig-pools', investments: 'mig-investments',
    transactions: 'mig-transactions', bankAccounts: 'mig-bankAccounts', addressDetails: 'mig-addressDetails',
  };
  const fd = new FormData();
  let fileCount = 0;
  for (const [key, elId] of Object.entries(fileMap)) {
    const f = document.getElementById(elId)?.files[0];
    if (f) { fd.append(key, f); fileCount++; }
  }
  if (!fileCount) return Toast.error('Please select at least one JSON file to migrate.');

  const btn = document.getElementById('migRunBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running migration…';

  try {
    const token = localStorage.getItem('svc_token');
    const res   = await fetch('/api/migrate/run', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Migration failed');

    const { counts, errors, errorCount } = data;
    const totalErrors = errorCount ?? errors.length;
    const errHtml = errors.length
      ? `<div style="margin-top:12px;padding:10px 12px;background:rgba(239,68,68,0.08);border-radius:8px;font-size:0.78rem;color:#ef4444">
           <strong>${totalErrors} error(s)${totalErrors > errors.length ? ` (showing first ${errors.length})` : ''}:</strong><br>${errors.map(e => `• ${e}`).join('<br>')}
         </div>`
      : '';

    document.getElementById('migResultsContent').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:12px">
        ${[
          ['Investors',    counts.investors    ?? 0, 'users',          '#22c55e'],
          ['Pools',        counts.pools        ?? 0, 'layer-group',    '#656565'],
          ['Investments',  counts.investments  ?? 0, 'chart-line',     '#fec24f'],
          ['Transactions', counts.transactions ?? 0, 'arrows-rotate',  '#eda5ff'],
          ['KYC Docs',     counts.kyc          ?? 0, 'id-card',        '#656565'],
        ].map(([label, count, icon, color]) => `
          <div style="background:var(--bg-secondary);border-radius:8px;padding:14px;text-align:center">
            <i class="fa-solid fa-${icon}" style="color:${color};font-size:1.2rem;margin-bottom:6px;display:block"></i>
            <div style="font-size:1.4rem;font-weight:700;color:var(--text)">${count.toLocaleString()}</div>
            <div style="font-size:0.75rem;color:var(--text-muted)">${label}</div>
          </div>
        `).join('')}
      </div>
      <div style="padding:10px 14px;background:rgba(34,197,94,0.08);border-radius:8px;font-size:0.85rem;color:#22c55e;text-align:center">
        <i class="fa-solid fa-check-circle"></i> Migration complete${errors.length ? ` with ${errors.length} error(s)` : ' — no errors'}
      </div>
      ${errHtml}
    `;
    document.getElementById('migResults').style.display = 'block';
    Toast.success('Migration complete!');
  } catch (e) {
    Toast.error(e.message || 'Migration failed');
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Run Again';
  }
}

async function backfillOrphanPools(btn) {
  await _withBtn(btn, async () => {
    try {
      const data = await API._fetch('POST', 'migrate/backfill-orphan-pools');
      if (data.created === 0) {
        Toast.success(data.message || 'No orphan pools found');
        return;
      }
      const list = data.pools.map(p =>
        `<li style="font-size:0.8rem;margin:4px 0"><span style="color:var(--gold);font-family:monospace">${_esc(p.pool_id)}</span> — ${_esc(p.name)} (${p.investments} investment${p.investments !== 1 ? 's' : ''})</li>`
      ).join('');
      Toast.success(`${data.created} orphan pool${data.created !== 1 ? 's' : ''} created`);
      const el = document.getElementById('orphanPoolsResult');
      if (el) el.innerHTML = `<ul style="margin:8px 0 0;padding-left:18px">${list}</ul>`;
    } catch (e) {
      Toast.error('Backfill failed: ' + (e.message || 'unknown error'));
    }
  });
}

let _emailInvestors = [];

async function loadInvestorUsersForEmail() {
  const btn    = document.getElementById('migLoadUsersBtn');
  const list   = document.getElementById('migEmailList');
  const toolbar = document.getElementById('migEmailToolbar');
  const sendBtn = document.getElementById('migResendBtn');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…';

  try {
    const data = await API._fetch('GET', 'migrate/investor-users');
    _emailInvestors = data.users || [];
    renderInvestorEmailList();
    toolbar.style.display = 'block';
    list.style.display = 'block';
    sendBtn.style.display = 'block';
    updateEmailStats();
  } catch (e) {
    Toast.error(e.message || 'Failed to load investors');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-rotate"></i> Reload';
  }
}

function renderInvestorEmailList() {
  const q = (document.getElementById('migEmailSearch')?.value || '').toLowerCase();
  const list = document.getElementById('migEmailList');
  const filtered = _emailInvestors.filter(u =>
    !q || `${u.first_name} ${u.last_name} ${u.email}`.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    list.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:0.8rem">No investors found</div>';
    return;
  }

  list.innerHTML = filtered.map(u => `
    <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
      <input type="checkbox" class="email-investor-cb" data-id="${u.id}" checked style="accent-color:#eda5ff;width:14px;height:14px;flex-shrink:0" onchange="updateEmailStats()">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.82rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.first_name || ''} ${u.last_name || ''}</div>
        <div style="font-size:0.74rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.email}</div>
      </div>
      ${u.has_logged_in ? '<span style="font-size:0.68rem;padding:2px 6px;background:rgba(34,197,94,0.12);color:#22c55e;border-radius:4px;flex-shrink:0">logged in</span>' : ''}
    </label>
  `).join('');

  updateEmailStats();
}

function filterInvestorEmailList() {
  renderInvestorEmailList();
}

function toggleAllEmailInvestors(checked) {
  document.querySelectorAll('.email-investor-cb').forEach(cb => { cb.checked = checked; });
  updateEmailStats();
}

function updateEmailStats() {
  const total    = document.querySelectorAll('.email-investor-cb').length;
  const selected = document.querySelectorAll('.email-investor-cb:checked').length;
  const stats    = document.getElementById('migEmailStats');
  const label    = document.getElementById('migResendLabel');
  if (stats) stats.textContent = `${selected} of ${total} selected`;
  if (label) label.textContent = selected ? `Send to ${selected} Investor${selected !== 1 ? 's' : ''}` : 'Send Setup Emails';
}

async function resendSetupEmails() {
  const btn = document.getElementById('migResendBtn');
  const resultEl = document.getElementById('migResendResult');

  const checked = [...document.querySelectorAll('.email-investor-cb:checked')];
  if (!checked.length) return Toast.error('Select at least one investor.');

  const userIds = checked.map(cb => cb.dataset.id);
  if (!confirm(`Send account setup emails to ${userIds.length} investor${userIds.length !== 1 ? 's' : ''}?`)) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
  resultEl.style.display = 'none';

  try {
    const data = await API._fetch('POST', 'migrate/resend-setup-emails', { userIds });
    const errHtml = data.errors?.length
      ? `<div style="margin-top:8px;font-size:0.75rem;color:#ef4444"><strong>${data.errors.length} failed:</strong><br>${data.errors.map(e => `• ${e}`).join('<br>')}</div>`
      : '';
    resultEl.innerHTML = `
      <div style="padding:10px 14px;background:rgba(34,197,94,0.08);border-radius:8px;font-size:0.85rem;color:#22c55e">
        <i class="fa-solid fa-check-circle"></i>
        Sent <strong>${data.sent}</strong> of <strong>${data.total}</strong> emails successfully.
      </div>${errHtml}`;
    resultEl.style.display = 'block';
    Toast.success(`${data.sent} setup email${data.sent !== 1 ? 's' : ''} sent`);
  } catch (e) {
    Toast.error(e.message || 'Failed to send emails');
  } finally {
    btn.disabled = false;
    updateEmailStats();
    btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> <span id="migResendLabel">${document.getElementById('migResendLabel')?.textContent || 'Send Setup Emails'}</span>`;
  }
}

async function recalculatePoolStats(btn) {
  const resultEl = document.getElementById('poolRecalcResult');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Recalculating…';
  resultEl.textContent = '';
  try {
    const data = await API._fetch('POST', 'admin/pools/recalculate');
    resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Updated ${data.poolsUpdated} pool${data.poolsUpdated !== 1 ? 's' : ''} successfully.</span>`;
    Toast.success(`Pool stats recalculated (${data.poolsUpdated} pools updated)`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Recalculation failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-calculator"></i> Recalculate Pool Stats';
  }
}

async function fixSmmeProductType(btn) {
  const resultEl = document.getElementById('smmeFixResult');
  if (!await Confirm.ask('Rename SMME → Short Term?', {
    body: 'This will update product_type from "smme" to "short_term" in all pools, investments, and products. Continue?',
    confirmLabel: 'Fix Now',
  })) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fixing…';
  if (resultEl) resultEl.textContent = '';
  try {
    const data = await API._fetch('POST', 'admin/pools/fix-product-type');
    if (resultEl) resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Fixed ${data.poolRows} pool(s), ${data.invRows} investment(s), ${data.prodRows} product(s).</span>`;
    Toast.success(`SMME → Short Term: ${data.total} record(s) updated`);
    await loadPools();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Fix failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Fix SMME Product Types';
  }
}

async function backfillFicaFromKyc(btn) {
  const resultEl = document.getElementById('ficaBackfillResult');
  if (!await Confirm.ask(
    'Approve FICA for all KYC-approved investors?',
    { body: 'This will set fica_status = "approved" and status = "active" for every investor whose kyc_status is already "approved". Continue?', confirmLabel: 'Run Backfill' }
  )) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…';
  resultEl.textContent = '';
  try {
    const data = await API._fetch('POST', 'admin/backfill/fica-from-kyc');
    resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Updated <strong>${data.updated}</strong> investor${data.updated !== 1 ? 's' : ''} (${data.fromKyc} from KYC→FICA, ${data.fromFica} from FICA→KYC sync).</span>`;
    Toast.success(`FICA backfill complete — ${data.updated} investors updated`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Backfill failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-shield-check"></i> Approve FICA for all KYC-approved clients';
  }
}

async function backfillInvestorDemographics(btn) {
  const resultEl = document.getElementById('demographicsBackfillResult');
  if (!await Confirm.ask(
    'Backfill investor demographics?',
    { body: 'This will derive Gender from the stored SA ID number and parse Heard About Us from the registration notes, for any investor missing those values. Continue?', confirmLabel: 'Run Backfill' }
  )) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…';
  resultEl.textContent = '';
  try {
    const data = await API._fetch('POST', 'admin/backfill/investor-demographics');
    if (data.gender_updated === 0 && data.heard_updated === 0) {
      resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> ${data.message || 'Nothing to backfill — all investors already have these fields.'}</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Checked <strong>${data.total_checked}</strong> investor(s) — Gender filled for <strong>${data.gender_updated}</strong>, Heard About Us filled for <strong>${data.heard_updated}</strong>.</span>`;
    }
    Toast.success(`Demographics backfill complete`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Backfill failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-person-circle-plus"></i> Backfill Gender &amp; Heard About Us';
  }
}

async function backfillCourseQuizzes(btn) {
  const resultEl = document.getElementById('quizBackfillResult');
  if (!await Confirm.ask(
    'Generate quizzes for all course modules missing them?',
    { body: 'This will call Claude for each module that has no quiz questions and generate 3 questions per module. Only modules without quizzes are affected. Continue?', confirmLabel: 'Generate Quizzes' }
  )) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating — this may take a minute…';
  resultEl.textContent = '';
  try {
    const data = await API._fetch('POST', 'ai/backfill-quizzes');
    if (data.updated === 0 && !data.errors?.length) {
      resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> ${data.message || 'All modules already have quizzes.'}</span>`;
    } else {
      const errHtml = data.errors?.length
        ? `<br><span style="color:#f59e0b">${data.errors.length} error(s): ${data.errors.map(e => e.module).join(', ')}</span>`
        : '';
      resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Generated quizzes for <strong>${data.updated}</strong> of <strong>${data.total}</strong> module(s).</span>${errHtml}`;
    }
    Toast.success(`Quiz backfill complete — ${data.updated} modules updated`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Quiz backfill failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Generate Missing Quizzes';
  }
}

async function reimportBankAccounts(btn) {
  const fileInput = document.getElementById('bankJsonFile');
  const resultEl  = document.getElementById('bankReimportResult');
  if (!fileInput?.files[0]) {
    Toast.error('Please choose a bankAccounts JSON file first.');
    return;
  }

  let bankAccounts;
  try {
    const text = await fileInput.files[0].text();
    bankAccounts = JSON.parse(text);
    if (!Array.isArray(bankAccounts)) throw new Error('File must contain a JSON array.');
  } catch (e) {
    Toast.error('Invalid JSON file: ' + e.message);
    return;
  }

  if (!await Confirm.ask('Re-import bank accounts?', {
    body: `File contains ${bankAccounts.length} records. This will update bank_name, bank_account_number, bank_account_holder, bank_branch_code, and bank_account_type for matching investors. Continue?`,
    confirmLabel: 'Re-import',
  })) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing…';
  resultEl.textContent = '';

  try {
    const data = await API._fetch('POST', 'admin/reimport-bank-accounts', { bankAccounts });
    const errHtml = data.errors?.length
      ? `<div style="margin-top:6px;font-size:0.75rem;color:#ef4444">${data.errors.map(e => `• ${_esc(e)}`).join('<br>')}</div>`
      : '';
    resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Done — <strong>${data.updated}</strong> investors updated, ${data.skipped} skipped (no match), ${data.total} active accounts in file.</span>${errHtml}`;
    Toast.success(`Bank accounts re-imported: ${data.updated} updated`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Re-import failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-building-columns"></i> Re-import Bank Accounts';
  }
}

async function promoteBankFromNotes(btn) {
  const resultEl = document.getElementById('bankPromoteResult');
  if (!await Confirm.ask('Promote bank data from notes?', {
    body: 'This will extract bank account data from the notes JSON column and populate the dedicated bank columns for investors where those columns are empty. Existing data is never overwritten. Continue?',
    confirmLabel: 'Promote',
  })) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Promoting…';
  resultEl.textContent = '';

  try {
    const data = await API._fetch('POST', 'admin/promote-bank-from-notes');
    resultEl.innerHTML = `<span style="color:#22c55e"><i class="fa-solid fa-check-circle"></i> Done — <strong>${data.updated}</strong> investors updated from notes (${data.checked} checked, ${data.skipped} skipped).</span>`;
    Toast.success(`Bank data promoted: ${data.updated} investors updated`);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444">${e.message || 'Failed'}</span>`;
    Toast.error(e.message || 'Promotion failed');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket"></i> Promote from Notes';
  }
}

/* ═══════════════════════════════════════════════
   COMPLIANCE CALENDAR
   ═══════════════════════════════════════════════ */
async function loadCompliance() {
  if (!STATE.investors.length) STATE.investors = (await API.investors.list({ limit: 5000 })).data || [];
  if (!STATE.investments.length) STATE.investments = (await API.investments.list({ limit: 5000 })).data || [];
  if (!STATE.kyc.length) STATE.kyc = (await API.kyc.list({ limit: 5000 })).data || [];

  const now = new Date();
  const year = now.getFullYear();

  const staticDeadlines = [
    { date: `${year}-03-31`, title: 'Annual Financial Statements', desc: 'Submit audited annual financial statements to FSCA', priority: 'high', _static: true },
    { date: `${year}-05-31`, title: 'FAIS Compliance Report', desc: 'Annual compliance report — key individuals and fit & proper', priority: 'high', _static: true },
    { date: `${year}-06-30`, title: 'POPIA Annual Review', desc: 'Review and update data processing records & privacy notices', priority: 'medium', _static: true },
    { date: `${year}-09-30`, title: 'AML Risk Assessment', desc: 'Annual Anti-Money Laundering risk assessment and policy review', priority: 'high', _static: true },
    { date: `${year}-12-31`, title: 'FSP License Renewal Review', desc: 'Confirm FSP license conditions and key individual qualifications', priority: 'medium', _static: true },
    { date: `${year + 1}-03-31`, title: 'Next Annual Financial Statements', desc: 'Prepare statutory financials for submission', priority: 'low', _static: true },
  ];

  // Load custom calendar items from the database
  let customItems = [];
  try {
    const calRes = await API._fetch('GET', 'tables/compliance_calendar', null, { limit: 200 });
    customItems = (calRes.data || []).map(c => ({
      id:    c.id,
      date:  c.due_date ? c.due_date.split('T')[0] : '',
      title: c.title,
      desc:  c.description || '',
      priority: c.priority || 'medium',
      status:   c.status || 'pending',
    }));
  } catch (_) {}

  const allDeadlines = [...staticDeadlines, ...customItems].sort((a, b) => new Date(a.date) - new Date(b.date));

  const calBody = document.getElementById('complianceCalBody');
  if (calBody) {
    calBody.innerHTML = allDeadlines.map(d => {
      const daysLeft = Math.ceil((new Date(d.date) - now) / 86400000);
      const isPast = daysLeft < 0;
      const isUrgent = daysLeft >= 0 && daysLeft <= 30;
      const isDone   = d.status === 'completed';
      const color = isDone ? '#22c55e' : isPast ? '#ef4444' : isUrgent ? '#fec24f' : '#656565';
      const label = isDone ? 'Done' : isPast ? 'Overdue' : isUrgent ? `${daysLeft}d left` : `${daysLeft}d`;
      const deleteBtn = !d._static ? `<button class="btn btn--danger btn--sm" style="margin-left:6px;padding:2px 8px;font-size:0.68rem" onclick='deleteComplianceItem(${JSON.stringify(d.id)})'><i class="fa-solid fa-trash"></i></button>` : '';
      const doneBtn   = !d._static && d.status !== 'completed' ? `<button class="btn btn--success btn--sm" style="margin-left:4px;padding:2px 8px;font-size:0.68rem" onclick='markComplianceDone(${JSON.stringify(d.id)})'><i class="fa-solid fa-check"></i></button>` : '';
      return `<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)${isDone ? ';opacity:0.55' : ''}">
        <div style="width:52px;min-width:52px;text-align:center;background:${color}22;border-radius:8px;padding:6px 4px">
          <div style="font-size:0.78rem;font-weight:800;color:${color}">${label}</div>
        </div>
        <div style="flex:1">
          <div style="font-size:0.85rem;font-weight:700;color:var(--text)${isDone ? ';text-decoration:line-through' : ''}">${_esc(d.title)}</div>
          ${d.desc ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px">${_esc(d.desc)}</div>` : ''}
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">Due: ${d.date}</div>
        </div>
        <div style="display:flex;align-items:center;gap:0">
          <span class="badge ${d.priority==='high'?'badge--red':d.priority==='medium'?'badge--yellow':'badge--grey'}" style="font-size:0.65rem">${d.priority}</span>
          ${doneBtn}${deleteBtn}
        </div>
      </div>`;
    }).join('');
  }

  // KYC expiry — documents with expiry_date within 60 days, plus stale pending KYC
  const kycEl = document.getElementById('kycExpiryBody');
  if (kycEl) {
    const in60 = new Date(now.getTime() + 60 * 86400000);
    const expiring = STATE.kyc.filter(k => k.expiry_date && new Date(k.expiry_date) <= in60);
    const stale = STATE.investors.filter(i => i.kyc_status === 'pending' && i.date_joined && (now - new Date(i.date_joined)) > 90 * 86400000).slice(0, 10);
    const alerts = [
      ...expiring.map(k => {
        const inv = STATE.investors.find(i => i.id === k.investor_id);
        const name = k.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : k.investor_id);
        const daysLeft = Math.ceil((new Date(k.expiry_date) - now) / 86400000);
        const isPast = daysLeft < 0;
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:0.82rem;font-weight:700;color:var(--text)">${_esc(name)}</div>
            <div style="font-size:0.7rem;color:var(--text-muted)">${_esc(k.doc_type || k.document_type || 'Document')} · expires ${Utils.date(k.expiry_date)}</div>
          </div>
          <span class="badge ${isPast ? 'badge--red' : 'badge--yellow'}" style="font-size:0.68rem">${isPast ? 'Expired' : `${daysLeft}d left`}</span>
        </div>`;
      }),
      ...stale.map(i => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div><div style="font-size:0.82rem;font-weight:700;color:var(--text)">${i.first_name} ${i.last_name}</div><div style="font-size:0.7rem;color:var(--text-muted)">${i.id} · pending &gt;90 days</div></div>
          <span class="badge badge--red" style="font-size:0.68rem">KYC Stale</span>
        </div>`),
    ];
    kycEl.innerHTML = alerts.length
      ? alerts.join('')
      : '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.82rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>No KYC expiry alerts</div>';
  }

  // Maturity instructions outstanding
  const matEl = document.getElementById('maturityActionBody');
  if (matEl) {
    const noInstr = STATE.investments.filter(i => i.status === 'matured' && (!i.maturity_instruction || i.maturity_instruction === 'pending')).slice(0, 8);
    matEl.innerHTML = noInstr.length
      ? noInstr.map(i => {
          const inv = STATE.investors.find(x => x.id === i.investor_id);
          const name = inv ? `${inv.first_name} ${inv.last_name}` : i.investor_id;
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <div><div style="font-size:0.82rem;font-weight:700;color:var(--text)">${name}</div><div style="font-size:0.7rem;color:var(--text-muted)">${Utils.rand(i.amount)} · ${i.pool_name||'—'}</div></div>
            <span class="badge badge--yellow" style="font-size:0.68rem">No instruction</span>
          </div>`;
        }).join('')
      : '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.82rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>All matured investments have instructions</div>';
  }

  // Document retention panel
  const retEl = document.getElementById('docRetentionBody');
  if (retEl) {
    const fiveYearsAgo = new Date(year - 5, now.getMonth(), now.getDate());
    const approvedKyc  = STATE.kyc.filter(k => k.status === 'approved').length;
    retEl.innerHTML = `
      <div class="info-list">
        <div class="info-row"><span class="info-row__label">Approved KYC Docs</span><span class="info-row__value text-green">${approvedKyc}</span></div>
        <div class="info-row"><span class="info-row__label">FICA Retention Period</span><span class="info-row__value">5 years (FIC Act)</span></div>
        <div class="info-row"><span class="info-row__label">Earliest Retention Date</span><span class="info-row__value">${fiveYearsAgo.toLocaleDateString('en-ZA')}</span></div>
        <div class="info-row"><span class="info-row__label">AML Compliance</span><span class="info-row__value text-green">Active — FICA compliant</span></div>
        <div class="info-row"><span class="info-row__label">POPIA Status</span><span class="info-row__value text-green">Compliant</span></div>
        <div class="info-row"><span class="info-row__label">FSCA License</span><span class="info-row__value td-gold">FSP 52449 — Active</span></div>
      </div>`;
  }
}

async function addComplianceItem() {
  const titleEl    = document.getElementById('compCalTitle');
  const descEl     = document.getElementById('compCalDesc');
  const dateEl     = document.getElementById('compCalDate');
  const priorityEl = document.getElementById('compCalPriority');
  const title      = titleEl?.value.trim();
  const dueDate    = dateEl?.value;
  if (!title) { Toast.error('Title is required'); return; }
  if (!dueDate) { Toast.error('Due date is required'); return; }
  try {
    await API._fetch('POST', 'tables/compliance_calendar', {
      title,
      description: descEl?.value.trim() || null,
      due_date:    dueDate,
      priority:    priorityEl?.value || 'medium',
      status:      'pending',
      created_by:  STATE.adminEmail || null,
    });
    Toast.success('Compliance item added');
    if (titleEl) titleEl.value = '';
    if (descEl)  descEl.value = '';
    if (dateEl)  dateEl.value = '';
    await loadCompliance();
  } catch (e) { Toast.error('Failed to add item: ' + (e.message || 'error')); }
}

async function deleteComplianceItem(id) {
  if (!await Confirm.ask('Delete this compliance item?', { body: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try {
    await API._fetch('DELETE', `tables/compliance_calendar/${id}`);
    Toast.success('Item removed');
    await loadCompliance();
  } catch (e) { Toast.error('Failed to remove item'); }
}

async function markComplianceDone(id) {
  try {
    await API._fetch('PATCH', `tables/compliance_calendar/${id}`, { status: 'completed' });
    Toast.success('Marked as completed');
    await loadCompliance();
  } catch (e) { Toast.error('Failed to update item'); }
}

/* ═══════════════════════════════════════════════
   FINANCIAL RECONCILIATION
   ═══════════════════════════════════════════════ */
async function loadReconciliation() {
  try {
    if (!STATE.investors.length)   STATE.investors   = (await API.investors.list({ limit: 5000 })).data || [];
    if (!STATE.transactions.length) STATE.transactions = (await API.transactions.list({ limit: 5000 })).data || [];
    if (!STATE.investments.length) STATE.investments  = (await API.investments.list({ limit: 5000 })).data || [];
    renderReconcTable();
  } catch (e) {
    Toast.error('Failed to load reconciliation data');
    console.error('[loadReconciliation]', e);
  }
}

function _reconcRows() {
  return STATE.investors.map(inv => {
    const txns = STATE.transactions.filter(t => t.investor_id === inv.id);
    const totalDeposited  = txns.filter(t => t.type === 'deposit' && t.status !== 'cancelled').reduce((s,t) => s+(parseFloat(t.amount)||0), 0);
    const totalInvested   = STATE.investments.filter(i => i.investor_id === inv.id && i.status !== 'cancelled').reduce((s,i) => s+(parseFloat(i.amount)||0), 0);
    const walletBalance   = parseFloat(inv.wallet_balance) || 0;
    const expectedWallet  = totalDeposited - totalInvested;
    const variance        = walletBalance - expectedWallet;
    const isDiscrepancy   = Math.abs(variance) > 1; // > R1 tolerance
    return { inv, totalDeposited, totalInvested, walletBalance, expectedWallet, variance, isDiscrepancy };
  });
}

function renderReconcTable() {
  const search    = (document.getElementById('reconcSearch')?.value || '').toLowerCase();
  const discOnly  = document.getElementById('reconcDiscrepOnly')?.checked || false;
  const fmt = v => 'R ' + Math.abs(v).toLocaleString('en-ZA', {minimumFractionDigits:2,maximumFractionDigits:2});

  let rows = _reconcRows();
  if (search) rows = rows.filter(r => `${r.inv.first_name} ${r.inv.last_name} ${r.inv.id||''} ${r.inv.email||''}`.toLowerCase().includes(search));
  if (discOnly) rows = rows.filter(r => r.isDiscrepancy);

  const totalDep  = rows.reduce((s,r) => s+r.totalDeposited, 0);
  const totalInv  = rows.reduce((s,r) => s+r.totalInvested, 0);
  const totalWal  = rows.reduce((s,r) => s+r.walletBalance, 0);
  const discCount = rows.filter(r => r.isDiscrepancy).length;

  // Update KPI tiles
  const statsEl = document.getElementById('reconcStats');
  if (statsEl) statsEl.innerHTML = `
    <div style="background:rgba(254,194,79,.08);border:1px solid rgba(254,194,79,.15);border-radius:12px;padding:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7a92a8;margin-bottom:6px">Total Deposits</div>
      <div style="font-size:1.35rem;font-weight:800;color:#fec24f">${fmt(totalDep)}</div>
    </div>
    <div style="background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.15);border-radius:12px;padding:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7a92a8;margin-bottom:6px">Total Invested</div>
      <div style="font-size:1.35rem;font-weight:800;color:#656565">${fmt(totalInv)}</div>
    </div>
    <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.15);border-radius:12px;padding:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7a92a8;margin-bottom:6px">Total Wallets</div>
      <div style="font-size:1.35rem;font-weight:800;color:#22c55e">${fmt(totalWal)}</div>
    </div>
    <div style="background:${discCount?'rgba(249,115,22,.1)':'rgba(34,197,94,.08)'};border:1px solid ${discCount?'rgba(249,115,22,.25)':'rgba(34,197,94,.15)'};border-radius:12px;padding:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#7a92a8;margin-bottom:6px">Discrepancies</div>
      <div style="font-size:1.35rem;font-weight:800;color:${discCount?'#f97316':'#22c55e'}">${discCount}</div>
    </div>`;

  // Update reconciliation badge
  const badge = document.getElementById('reconcBadge');
  if (badge) { badge.textContent = discCount; badge.style.display = discCount ? '' : 'none'; }

  const subtitle = document.getElementById('reconcSubtitle');
  if (subtitle) subtitle.textContent = `${rows.length} investors · ${discCount} discrepancies flagged`;

  const tbody = document.getElementById('reconcBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#7a92a8">No records found</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const varColor = r.isDiscrepancy ? (r.variance < 0 ? 'color:#ef4444' : 'color:#f97316') : 'color:#22c55e';
    const statusBadge = r.isDiscrepancy
      ? `<span style="background:rgba(249,115,22,.15);color:#f97316;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">⚠ Discrepancy</span>`
      : `<span style="background:rgba(34,197,94,.12);color:#22c55e;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">✓ Balanced</span>`;
    return `<tr>
      <td style="font-weight:600;font-size:0.83rem">${_esc(r.inv.first_name)} ${_esc(r.inv.last_name)}</td>
      <td style="font-size:0.78rem;font-family:monospace;color:#fec24f">${_esc(r.inv.id)||'—'}</td>
      <td style="font-size:0.78rem;color:#7a92a8">${_esc(r.inv.email)||'—'}</td>
      <td style="color:#fec24f;font-size:0.82rem;font-weight:600">${fmt(r.totalDeposited)}</td>
      <td style="color:#656565;font-size:0.82rem;font-weight:600">${fmt(r.totalInvested)}</td>
      <td style="color:#22c55e;font-size:0.82rem;font-weight:600">${fmt(r.walletBalance)}</td>
      <td style="color:#9ca3af;font-size:0.82rem">${fmt(r.expectedWallet)}</td>
      <td style="font-size:0.82rem;font-weight:700;${varColor}">${r.variance >= 0 ? '+' : '-'}${fmt(r.variance)}</td>
      <td>${statusBadge}</td>
      <td><button class="btn btn--secondary btn--sm" onclick='openManualCreditModal(${JSON.stringify(r.inv.id)}, ${JSON.stringify(r.inv.first_name + ' ' + r.inv.last_name)})'><i class="fa-solid fa-plus"></i> Credit</button></td>
    </tr>`;
  }).join('');

  const footer = document.getElementById('reconcFooter');
  if (footer) footer.textContent = `${rows.length} investors shown · ${discCount} discrepancy${discCount!==1?'ies':''} · Variance tolerance R1.00`;
}

function openManualCreditModal(investorId, investorName) {
  document.getElementById('manualCreditInvestorId').value = investorId;
  document.getElementById('manualCreditInvestorName').textContent = investorName;
  document.getElementById('manualCreditAmount').value = '';
  document.getElementById('manualCreditNotes').value = '';
  Modal.open('manualCreditModal');
}

async function submitManualCredit() {
  const investorId = document.getElementById('manualCreditInvestorId').value;
  const amount = parseFloat(document.getElementById('manualCreditAmount').value);
  const notes = document.getElementById('manualCreditNotes').value.trim();
  if (!investorId || isNaN(amount) || amount <= 0) { Toast.error('Enter a valid positive amount'); return; }
  const name = document.getElementById('manualCreditInvestorName').textContent;
  if (!await Confirm.ask(`Credit R${amount.toFixed(2)} to ${name}?`, { body: notes || 'No notes provided.', confirmLabel: 'Credit Wallet' })) return;
  try {
    const res = await fetch('/api/admin/manual-credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ investorId, amount, notes: notes || null }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Request failed');
    Toast.success(`Wallet credited R${amount.toFixed(2)} successfully`);
    Modal.close('manualCreditModal');
    // Refresh investor data so reconciliation reflects the new balance
    const inv = STATE.investors.find(i => i.id === investorId);
    if (inv) inv.wallet_balance = (parseFloat(inv.wallet_balance) || 0) + amount;
    renderReconcTable();
  } catch (e) {
    Toast.error('Credit failed: ' + (e.message || 'unknown error'));
  }
}

function exportReconciliationCSV() {
  const rows = _reconcRows();
  if (!rows.length) { Toast.warning('No data to export'); return; }
  const fmt = v => v.toFixed(2);
  const headers = ['Client','Account No.','Email','Total Deposited','Total Invested','Wallet Balance','Expected Wallet','Variance','Status'];
  const data = rows.map(r => [
    `${r.inv.first_name} ${r.inv.last_name}`, r.inv.id||'', r.inv.email||'',
    fmt(r.totalDeposited), fmt(r.totalInvested), fmt(r.walletBalance),
    fmt(r.expectedWallet), fmt(r.variance),
    r.isDiscrepancy ? 'DISCREPANCY' : 'BALANCED'
  ]);
  const esc = v => { const s=String(v); return (s.includes(',')||s.includes('"'))?'"'+s.replace(/"/g,'""')+'"':s; };
  const csv = [headers.map(esc).join(','), ...data.map(r=>r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='reconciliation.csv'; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  Toast.success('Reconciliation CSV exported');
}

/* ═══════════════════════════════════════════════
   ACCEPTED CLIENT DOCUMENTS
   ═══════════════════════════════════════════════ */
let _acdRows = [];

async function loadAcceptedDocuments() {
  const tbody  = document.getElementById('acdBody');
  const footer = document.getElementById('acdFooter');
  const stats  = document.getElementById('acdStats');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#7a92a8"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</td></tr>';

  try {
    const [docsRes, investorsRes] = await Promise.all([
      fetch('/api/tables/accepted_client_documents?limit=2000&order=accepted_at.desc', { credentials: 'include' }),
      Promise.resolve(STATE.investors)
    ]);

    const docs = docsRes.ok ? await docsRes.json() : [];
    const investors = Array.isArray(investorsRes) ? investorsRes : STATE.investors || [];

    // Build investor lookup map
    const invMap = {};
    investors.forEach(i => { invMap[i.id] = i; });

    // Attach investor info to each doc row
    _acdRows = (Array.isArray(docs) ? docs : docs.data || []).map(d => ({
      ...d,
      investor: invMap[d.investor_id] || null,
    }));

    // Stats
    if (stats) {
      const types = ['terms_of_service','privacy_policy','popia_notice','fica_consent','risk_disclaimer'];
      const total   = _acdRows.length;
      const uniqInv = new Set(_acdRows.map(d => d.investor_id)).size;
      const today   = _acdRows.filter(d => new Date(d.accepted_at) > new Date(Date.now() - 86400000)).length;
      stats.innerHTML = [
        { label:'Total Acceptances', value: total,    color:'#fec24f' },
        { label:'Unique Investors',  value: uniqInv,  color:'#22c55e' },
        { label:'Accepted Today',    value: today,    color:'#656565' },
        { label:'Document Types',    value: types.filter(t => _acdRows.some(d => d.document_type === t)).length, color:'#eda5ff' },
      ].map(s => `
        <div class="stat-card">
          <div class="stat-card__label">${s.label}</div>
          <div class="stat-card__value" style="color:${s.color}">${s.value.toLocaleString()}</div>
        </div>
      `).join('');
    }

    // Badge
    const badge = document.getElementById('acceptedDocsBadge');
    if (badge) { badge.textContent = _acdRows.length > 99 ? '99+' : _acdRows.length; badge.style.display = _acdRows.length ? 'inline-flex' : 'none'; }

    renderAcceptedDocsTable();
  } catch (e) {
    console.error('[loadAcceptedDocuments]', e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#ef4444">Failed to load — ${_esc(e.message)}</td></tr>`;
  }
}

const _DOC_TYPE_LABELS = {
  terms_of_service: 'Terms of Service',
  privacy_policy:   'Privacy Policy',
  popia_notice:     'POPIA Notice',
  fica_consent:     'FICA Consent',
  risk_disclaimer:  'Risk Disclaimer',
};

function renderAcceptedDocsTable() {
  const tbody   = document.getElementById('acdBody');
  const footer  = document.getElementById('acdFooter');
  const search  = (document.getElementById('acdSearch')?.value || '').toLowerCase();
  const typeVal = document.getElementById('acdTypeFilter')?.value || '';

  if (!tbody) return;

  let rows = _acdRows;
  if (typeVal) rows = rows.filter(d => d.document_type === typeVal);
  if (search) rows = rows.filter(d => {
    const name = d.investor ? `${d.investor.first_name} ${d.investor.last_name}`.toLowerCase() : '';
    const email = d.investor?.email?.toLowerCase() || '';
    const type  = (d.document_type || '').toLowerCase();
    return name.includes(search) || email.includes(search) || type.includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#7a92a8"><i class="fa-solid fa-file-circle-check" style="margin-right:8px"></i>No accepted documents found</td></tr>`;
    if (footer) footer.textContent = '0 records';
    return;
  }

  const docColor = { terms_of_service:'#656565', privacy_policy:'#22c55e', popia_notice:'#eda5ff', fica_consent:'#fec24f', risk_disclaimer:'#ef4444' };

  tbody.innerHTML = rows.map(d => {
    const inv  = d.investor;
    const name = inv ? `${_esc(inv.first_name)} ${_esc(inv.last_name)}` : `<span style="color:#7a92a8">${_esc(d.investor_id || '—')}</span>`;
    const email = inv ? `<div style="font-size:0.72rem;color:#7a92a8">${_esc(inv.email || '')}</div>` : '';
    const col  = docColor[d.document_type] || '#7a92a8';
    const label = _DOC_TYPE_LABELS[d.document_type] || d.document_type;
    const acceptedAt = d.accepted_at ? new Date(d.accepted_at).toLocaleString('en-ZA', { dateStyle:'medium', timeStyle:'short' }) : '—';
    const ua = d.user_agent ? d.user_agent.replace(/\(.*?\)/g,'').replace(/\s{2,}/g,' ').trim().slice(0,40) : '—';

    return `<tr>
      <td style="white-space:nowrap">${name}${email}</td>
      <td><span style="background:${col}22;color:${col};padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:700">${label}</span></td>
      <td style="color:#7a92a8;font-size:0.8rem">${_esc(d.document_version || '1.0')}</td>
      <td style="font-size:0.82rem;white-space:nowrap">${acceptedAt}</td>
      <td style="font-size:0.78rem;color:#7a92a8;font-family:monospace">${_esc(d.ip_address || '—')}</td>
      <td style="font-size:0.72rem;color:#7a92a8;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(d.user_agent || '')}">${_esc(ua)}</td>
    </tr>`;
  }).join('');

  if (footer) footer.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''} · sorted by acceptance date`;
}

function exportAcceptedDocsCSV() {
  if (!_acdRows.length) { Toast.warning('No data to export'); return; }
  const headers = ['Investor ID','First Name','Last Name','Email','Document Type','Version','Accepted At','IP Address'];
  const esc = v => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  const data = _acdRows.map(d => [
    d.investor_id || '', d.investor?.first_name || '', d.investor?.last_name || '', d.investor?.email || '',
    _DOC_TYPE_LABELS[d.document_type] || d.document_type, d.document_version || '1.0',
    d.accepted_at ? new Date(d.accepted_at).toISOString() : '', d.ip_address || '',
  ]);
  const csv = [headers.map(esc).join(','), ...data.map(r => r.map(esc).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `accepted-client-documents-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  Toast.success('Accepted documents CSV exported');
}

/* ═══════════════════════════════════════════════
   PDF EXPORTS
   ═══════════════════════════════════════════════ */
function exportInvestorsPDF() {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) { Toast.warning('PDF library loading — try again in a moment'); return; }
  const inv = STATE.investors;
  if (!inv.length) { Toast.warning('No investors to export'); return; }
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
  doc.setFontSize(16); doc.setTextColor(212,175,55);
  doc.text('SV Capital — Investor Register', 14, 16);
  doc.setFontSize(9); doc.setTextColor(100,116,139);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')} · ${inv.length} investors · FSP 52449`, 14, 22);
  doc.autoTable({
    startY: 27,
    head: [['Name','Email','Phone','KYC Status','FICA','Province','Wallet Balance','Status']],
    body: inv.map(i => [
      `${i.first_name} ${i.last_name}`, i.email||'', i.phone||'',
      i.kyc_status||'pending', i.fica_status||'pending', i.province||'',
      'R '+(parseFloat(i.wallet_balance)||0).toFixed(2),
      i.status||'pending'
    ]),
    styles:{ fontSize:7, cellPadding:2.5 },
    headStyles:{ fillColor:[13,17,23], textColor:[212,175,55], fontStyle:'bold' },
    alternateRowStyles:{ fillColor:[248,250,252] },
    theme:'grid'
  });
  doc.save('investor_register.pdf');
  Toast.success('PDF exported');
}

function exportKYCReportPDF() {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) { Toast.warning('PDF library loading — try again in a moment'); return; }
  const docs = STATE.kyc;
  if (!docs.length) { Toast.warning('No KYC records to export'); return; }
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
  doc.setFontSize(16); doc.setTextColor(212,175,55);
  doc.text('SV Capital — KYC/FICA Compliance Report', 14, 16);
  doc.setFontSize(9); doc.setTextColor(100,116,139);
  const approved = docs.filter(d=>d.status==='approved').length;
  const pending  = docs.filter(d=>d.status==='pending'||d.status==='under_review').length;
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')} · ${docs.length} documents · ${approved} approved · ${pending} pending`, 14, 22);
  doc.autoTable({
    startY: 27,
    head: [['Investor ID','Document Type','Status','Submitted','Reviewed By','Reviewed Date']],
    body: docs.map(d => [
      d.investor_id||'', (d.document_type||'').replace(/_/g,' '),
      (d.status||'').toUpperCase(), d.submitted_at ? new Date(d.submitted_at).toLocaleDateString('en-ZA') : '—',
      d.reviewed_by||'—', d.reviewed_at ? new Date(d.reviewed_at).toLocaleDateString('en-ZA') : '—'
    ]),
    styles:{ fontSize:7.5, cellPadding:2.5 },
    headStyles:{ fillColor:[13,17,23], textColor:[212,175,55], fontStyle:'bold' },
    alternateRowStyles:{ fillColor:[248,250,252] },
    theme:'grid'
  });
  doc.save('kyc_compliance_report.pdf');
  Toast.success('KYC report PDF exported');
}

/* ═══════════════════════════════════════════════
   COMMAND PALETTE (Ctrl+K)
   ═══════════════════════════════════════════════ */
const ADMIN_CMD_ITEMS = [
  // Views
  { label:'Dashboard',               icon:'fa-border-all',               view:'dashboard' },
  { label:'Investor Management',     icon:'fa-users',                    view:'investors' },
  { label:'IFA Management',          icon:'fa-handshake',                view:'ifa' },
  { label:'KYC / FICA',              icon:'fa-id-card',                  view:'kyc' },
  { label:'Investment Pools',        icon:'fa-layer-group',              view:'pools' },
  { label:'Investments',             icon:'fa-chart-line',               view:'investments' },
  { label:'Maturity Instructions',   icon:'fa-hourglass-end',            view:'maturity' },
  { label:'Transactions',            icon:'fa-arrows-rotate',            view:'transactions' },
  { label:'Withdrawals',             icon:'fa-arrow-up-from-bracket',    view:'withdrawals' },
  { label:'Support Tickets',         icon:'fa-headset',                  view:'support' },
  { label:'AML Review',              icon:'fa-shield-halved',            view:'aml' },
  { label:'Communications',          icon:'fa-paper-plane',              view:'comms' },
  { label:'Analytics',               icon:'fa-chart-pie',                view:'analytics' },
  { label:'Compliance Calendar',     icon:'fa-calendar-check',           view:'compliance' },
  { label:'Audit Log',               icon:'fa-scroll',                   view:'auditlog' },
  { label:'Financial Reconciliation',icon:'fa-scale-balanced',           view:'reconciliation' },
  { label:'Settings',                icon:'fa-gear',                     view:'settings' },
  { label:'Data Migration',          icon:'fa-database',                 view:'migrate' },
  // Actions
  { label:'Add New Investor',        icon:'fa-user-plus',                action: ()=>{ navigate('investors', document.querySelector('[data-view=investors]')); setTimeout(()=>document.getElementById('openAddInvestorBtn')?.click(),300); } },
  { label:'Upload KYC Document',     icon:'fa-upload',                   action: ()=>navigate('kyc', document.querySelector('[data-view=kyc]')) },
  { label:'Create Investment Pool',  icon:'fa-plus-circle',              action: ()=>{ navigate('pools', document.querySelector('[data-view=pools]')); setTimeout(openAddPoolModal, 300); } },
  { label:'Record Transaction',      icon:'fa-plus',                     action: ()=>{ navigate('transactions', document.querySelector('[data-view=transactions]')); setTimeout(openAddTxnModal, 300); } },
  { label:'Export Investors CSV',    icon:'fa-file-csv',                 action: ()=>exportInvestorsCSV() },
  { label:'Export Investors PDF',    icon:'fa-file-pdf',                 action: ()=>exportInvestorsPDF() },
  { label:'Export KYC CSV',          icon:'fa-file-csv',                 action: ()=>exportKYCCSV() },
  { label:'Export KYC PDF',          icon:'fa-file-pdf',                 action: ()=>exportKYCReportPDF() },
  { label:'Export Transactions CSV', icon:'fa-file-csv',                 action: ()=>exportTransactionsCSV() },
  { label:'Export Reconciliation',   icon:'fa-file-csv',                 action: ()=>exportReconciliationCSV() },
];
let _adminCmdActive = -1;

function openAdminCmd() {
  const ov = document.getElementById('adminCmdOverlay');
  if (!ov) return;
  ov.style.display = 'flex';
  _adminCmdActive = -1;
  const inp = document.getElementById('adminCmdInput');
  if (inp) { inp.value = ''; inp.focus(); }
  renderAdminCmdResults('');
}

function closeAdminCmd() {
  const ov = document.getElementById('adminCmdOverlay');
  if (ov) ov.style.display = 'none';
}

function renderAdminCmdResults(q) {
  const el = document.getElementById('adminCmdResults');
  if (!el) return;
  _adminCmdActive = -1;
  const query = (q||'').toLowerCase().trim();
  const filtered = query ? ADMIN_CMD_ITEMS.filter(c => c.label.toLowerCase().includes(query)) : ADMIN_CMD_ITEMS;
  if (!filtered.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:#7a92a8;font-size:13px">No results for "${_esc(q)}"</div>`;
    el._filtered = []; return;
  }
  el.innerHTML = filtered.map((c,i) =>
    `<div class="adm-cmd-item" data-idx="${i}" onmouseenter="adminCmdHover(${i})" onclick="adminCmdSelect(${i})"
      style="display:flex;align-items:center;gap:12px;padding:10px 18px;cursor:pointer;transition:background .1s;color:#e8edf2;font-size:13px">
      <i class="fa-solid ${c.icon}" style="width:16px;text-align:center;color:#7a92a8;font-size:13px"></i>
      <span>${c.label}</span>
      ${c.view?`<kbd style="margin-left:auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:4px;font-size:10px;padding:1px 6px;color:#7a92a8">${c.view}</kbd>`:''}
    </div>`
  ).join('');
  el._filtered = filtered;
}

function adminCmdHover(idx) {
  _adminCmdActive = idx;
  document.querySelectorAll('.adm-cmd-item').forEach((el,i) => {
    el.style.background = i === idx ? 'rgba(254,194,79,.1)' : '';
  });
}

function adminCmdSelect(idx) {
  const el = document.getElementById('adminCmdResults');
  const filtered = el?._filtered || ADMIN_CMD_ITEMS;
  const item = filtered[idx];
  if (!item) return;
  closeAdminCmd();
  if (item.action) { item.action(); return; }
  if (item.view) navigate(item.view, document.querySelector(`[data-view="${item.view}"]`));
}

function adminCmdKeyNav(e) {
  const el = document.getElementById('adminCmdResults');
  const filtered = el?._filtered || [];
  const count = filtered.length;
  if (!count) return;
  if (e.key==='ArrowDown') { e.preventDefault(); adminCmdHover((_adminCmdActive+1)%count); }
  if (e.key==='ArrowUp')   { e.preventDefault(); adminCmdHover((_adminCmdActive-1+count)%count); }
  if (e.key==='Enter')     { e.preventDefault(); if (_adminCmdActive>=0) adminCmdSelect(_adminCmdActive); else if(count>0) adminCmdSelect(0); }
  if (e.key==='Escape')    { closeAdminCmd(); }
}

/* ═══════════════════════════════════════════════
   FICA PIPELINE
   ═══════════════════════════════════════════════ */
let _ficaStageFilter = 'all';

function _ficaStageOf(inv) {
  if (inv.fica_status === 'approved' || inv.kyc_status === 'verified') return 'approved';
  const docs = (STATE.kyc || []).filter(d => d.investor_id === inv.id && !d.sub_account_id);
  if (!docs.length) return 'not_started';
  if (docs.some(d => d.status === 'rejected')) return 'rejected';
  if (docs.some(d => d.status === 'approved')) return 'in_review';
  return 'submitted';
}

const _ficaStageLabels = {
  not_started: 'Not Started',
  submitted:   'Docs Submitted',
  in_review:   'In Review',
  approved:    'Approved',
  rejected:    'Rejected / Issues',
};

const _ficaStageColors = {
  not_started: { bg: 'rgba(122,146,168,.12)', border: 'rgba(122,146,168,.2)', text: '#7a92a8', badge: 'rgba(122,146,168,.15)', badgeText: '#7a92a8' },
  submitted:   { bg: 'rgba(254,194,79,.08)',  border: 'rgba(254,194,79,.15)', text: '#fec24f', badge: 'rgba(254,194,79,.15)',  badgeText: '#fec24f' },
  in_review:   { bg: 'rgba(59,130,246,.08)',  border: 'rgba(59,130,246,.15)', text: '#60a5fa', badge: 'rgba(59,130,246,.15)',  badgeText: '#60a5fa' },
  approved:    { bg: 'rgba(34,197,94,.08)',   border: 'rgba(34,197,94,.15)',  text: '#22c55e', badge: 'rgba(34,197,94,.12)',   badgeText: '#22c55e' },
  rejected:    { bg: 'rgba(239,68,68,.08)',   border: 'rgba(239,68,68,.15)',  text: '#ef4444', badge: 'rgba(239,68,68,.12)',   badgeText: '#ef4444' },
};

async function loadFicaPipeline() {
  try {
    const [invRes, kycRes] = await Promise.all([
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 5000 }),
      STATE.kyc.length ? Promise.resolve({ data: STATE.kyc }) : API._fetch('GET', 'tables/kyc_documents?limit=5000'),
    ]);
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    if (!STATE.kyc.length) STATE.kyc = kycRes.data || [];
    _renderFicaPipeline();
  } catch (e) { Toast.error('Failed to load FICA pipeline'); }
}

function _renderFicaPipeline() {
  const stageOrder = ['not_started','submitted','in_review','approved','rejected'];
  const search = (document.getElementById('ficaPipelineSearch')?.value || '').toLowerCase();

  // Priority: investors who have pending/under_review investments are surfaced first
  const _hasPendingInvestment = inv => (STATE.investments || []).some(
    inv2 => inv2.investor_id === inv.id && ['pending','under_review','active'].includes(inv2.status)
  );

  const investors = STATE.investors.filter(inv => {
    if (inv.role && inv.role !== 'investor') return false;
    if (search) {
      const full = `${inv.first_name} ${inv.last_name} ${inv.email || ''}`.toLowerCase();
      if (!full.includes(search)) return false;
    }
    if (_ficaStageFilter !== 'all') return _ficaStageOf(inv) === _ficaStageFilter;
    return true;
  }).sort((a, b) => {
    // Investors with active investments who are NOT yet fully FICA-verified bubble up
    const aStage = _ficaStageOf(a), bStage = _ficaStageOf(b);
    const aPriority = _hasPendingInvestment(a) && aStage !== 'approved' ? 2 : _hasPendingInvestment(a) ? 1 : 0;
    const bPriority = _hasPendingInvestment(b) && bStage !== 'approved' ? 2 : _hasPendingInvestment(b) ? 1 : 0;
    return bPriority - aPriority;
  });

  const counts = {};
  stageOrder.forEach(s => counts[s] = 0);
  STATE.investors.forEach(inv => {
    if (inv.role && inv.role !== 'investor') return;
    const s = _ficaStageOf(inv);
    counts[s] = (counts[s] || 0) + 1;
  });

  const tilesEl = document.getElementById('ficaPipelineTiles');
  if (tilesEl) {
    tilesEl.innerHTML = [
      { key: 'all', label: 'All Investors', count: Object.values(counts).reduce((a,b) => a+b, 0), c: { bg:'rgba(255,255,255,.04)', border:'rgba(255,255,255,.08)', text:'#e8edf2', badge:'rgba(255,255,255,.08)', badgeText:'#e8edf2' } },
      ...stageOrder.map(s => ({ key: s, label: _ficaStageLabels[s], count: counts[s], c: _ficaStageColors[s] })),
    ].map(({ key, label, count, c }) => `
      <div onclick="_ficaSetStage('${key}')" style="cursor:pointer;background:${c.bg};border:1px solid ${key===_ficaStageFilter?c.text:c.border};border-radius:12px;padding:14px 16px;transition:border-color .15s${key===_ficaStageFilter?';box-shadow:0 0 0 2px '+c.text+'22':''}" title="Filter: ${label}">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${c.text};margin-bottom:6px">${label}</div>
        <div style="font-size:1.5rem;font-weight:800;color:${c.text}">${count}</div>
      </div>`).join('');
  }

  const tbody = document.getElementById('ficaPipelineBody');
  if (!tbody) return;
  if (!investors.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:#7a92a8">No investors match the current filter</td></tr>`;
    return;
  }
  tbody.innerHTML = investors.map(inv => {
    const stage = _ficaStageOf(inv);
    const c = _ficaStageColors[stage];
    const docs = (STATE.kyc || []).filter(d => d.investor_id === inv.id && !d.sub_account_id);
    const docCount = docs.length;
    const approvedCount = docs.filter(d => d.status === 'approved').length;
    const stageBadge = `<span style="background:${c.badge};color:${c.badgeText};border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700">${_ficaStageLabels[stage]}</span>`;
    const hasPriority = _hasPendingInvestment(inv) && stage !== 'approved';
    const priorityBadge = hasPriority
      ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:0.62rem;font-weight:700;color:#fec24f;background:rgba(254,194,79,0.12);border:1px solid rgba(254,194,79,0.3);border-radius:4px;padding:1px 6px;margin-left:4px" title="Has active investment — KYC verification pending"><i class="fa-solid fa-bolt" style="font-size:0.58rem"></i>Priority</span>`
      : '';
    return `<tr style="${hasPriority ? 'background:rgba(254,194,79,0.02)' : ''}">
      <td><div style="font-weight:600;font-size:0.83rem">${_esc(inv.first_name)} ${_esc(inv.last_name)} ${priorityBadge}</div><div style="font-size:0.72rem;color:#7a92a8">${_esc(inv.email||'')}</div></td>
      <td style="font-size:0.82rem;color:#7a92a8">${Utils.date(inv.created_at)}</td>
      <td>${stageBadge}</td>
      <td style="font-size:0.82rem;color:#7a92a8">${docCount ? `${approvedCount}/${docCount} approved` : '—'}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn--secondary btn--sm" title="View KYC timeline" onclick='openKycTimeline(${JSON.stringify(inv.id)})'><i class="fa-solid fa-timeline"></i> Timeline</button>
          <button class="btn btn--secondary btn--sm" onclick='navigate("kyc", document.querySelector("[data-view=kyc]"))'><i class="fa-solid fa-id-card"></i> Queue</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const subtitle = document.getElementById('ficaPipelineSubtitle');
  if (subtitle) subtitle.textContent = `${investors.length} investor${investors.length!==1?'s':''} shown · filter: ${_ficaStageFilter === 'all' ? 'all stages' : _ficaStageLabels[_ficaStageFilter]}`;
}

function _ficaSetStage(stage) {
  _ficaStageFilter = stage;
  _renderFicaPipeline();
}

/* ═══════════════════════════════════════════════
   INTERNATIONAL INTEREST
   ═══════════════════════════════════════════════ */
let _intlData = [];

async function loadIntlInterest() {
  try {
    const res = await API._fetch('GET', 'tables/international_waitlist?limit=2000&sort=created_at&order=desc');
    _intlData = res.data || [];
    _renderIntlInterest(_intlData);
    _updateIntlStats(_intlData);
    _buildIntlCountryFilter(_intlData);
    const badge = document.getElementById('intlInterestBadge');
    if (badge) { badge.textContent = _intlData.length; badge.style.display = _intlData.length ? '' : 'none'; }
  } catch (err) {
    console.error('[intl interest] load error:', err);
    const body = document.getElementById('intlInterestBody');
    if (body) body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#ef4444;padding:24px">Failed to load: ${err.message}</td></tr>`;
  }
}

function _updateIntlStats(data) {
  const el = v => document.getElementById(v);
  if (el('ii-total')) el('ii-total').textContent = data.length.toLocaleString();
  const countries = [...new Set(data.map(r => r.country).filter(Boolean))];
  if (el('ii-countries')) el('ii-countries').textContent = countries.length;
  const now = new Date();
  const thisMonth = data.filter(r => {
    const d = new Date(r.created_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
  if (el('ii-this-month')) el('ii-this-month').textContent = thisMonth;
}

function _buildIntlCountryFilter(data) {
  const sel = document.getElementById('intlCountryFilter');
  if (!sel) return;
  const countries = [...new Set(data.map(r => r.country).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All countries</option>' +
    countries.map(c => `<option value="${_esc(c)}">${_esc(c)}</option>`).join('');
}

function _renderIntlInterest(data) {
  const body = document.getElementById('intlInterestBody');
  const footer = document.getElementById('intlInterestFooter');
  if (!body) return;
  if (!data.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#7a92a8;padding:32px"><i class="fa-solid fa-earth-africa" style="font-size:1.5rem;margin-bottom:8px;display:block"></i>No international interest registrations yet</td></tr>`;
    if (footer) footer.textContent = '';
    return;
  }
  body.innerHTML = data.map(r => {
    const contacted = r.status === 'contacted';
    const statusBadge = contacted
      ? `<span style="background:rgba(100,237,0,0.15);color:#65ed00;padding:2px 8px;border-radius:20px;font-size:0.72rem;font-weight:700"><i class="fa-solid fa-check"></i> Contacted</span>`
      : `<span style="background:rgba(254,194,79,0.15);color:#fec24f;padding:2px 8px;border-radius:20px;font-size:0.72rem;font-weight:700">New</span>`;
    return `<tr>
      <td style="font-weight:600;color:#e8edf2">${_esc(r.full_name || '—')}</td>
      <td><a href="mailto:${_esc(r.email)}" style="color:#fec24f;text-decoration:none">${_esc(r.email)}</a></td>
      <td>${_esc(r.country || '—')}</td>
      <td>${statusBadge}</td>
      <td style="color:#7a92a8">${r.created_at ? new Date(r.created_at).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
      <td>
        <div style="display:flex;gap:6px">
          ${!contacted ? `<button class="btn btn--sm btn--success" onclick='markIntlContacted(${JSON.stringify(r.id)})' title="Mark as contacted"><i class="fa-solid fa-check"></i></button>` : ''}
          <a class="btn btn--sm btn--secondary" href="mailto:${_esc(r.email)}?subject=${encodeURIComponent('SVCapital International Investment Enquiry')}" title="Send email"><i class="fa-solid fa-envelope"></i></a>
        </div>
      </td>
    </tr>`;
  }).join('');
  if (footer) footer.textContent = `${data.length} registration${data.length !== 1 ? 's' : ''}`;
}

async function markIntlContacted(id) {
  try {
    await API._fetch('PATCH', `tables/international_waitlist/${id}`, { status: 'contacted' });
    const rec = _intlData.find(r => r.id === id);
    if (rec) rec.status = 'contacted';
    _renderIntlInterest(_intlData);
    Toast.success('Marked as contacted');
  } catch (e) { Toast.error('Failed to update status'); }
}

function filterIntlInterest(q) {
  const lower = (q || '').toLowerCase();
  const filtered = lower
    ? _intlData.filter(r =>
        (r.full_name || '').toLowerCase().includes(lower) ||
        (r.email || '').toLowerCase().includes(lower) ||
        (r.country || '').toLowerCase().includes(lower))
    : _intlData;
  _renderIntlInterest(filtered);
}

function filterIntlInterestCountry(country) {
  const filtered = country
    ? _intlData.filter(r => r.country === country)
    : _intlData;
  _renderIntlInterest(filtered);
}

function exportIntlInterestCSV() {
  if (!_intlData.length) { Toast.info('No data to export.'); return; }
  const rows = [['Full Name', 'Email', 'Country', 'Registered At']];
  _intlData.forEach(r => rows.push([
    `"${(r.full_name || '').replace(/"/g, '""')}"`,
    `"${(r.email || '').replace(/"/g, '""')}"`,
    `"${(r.country || '').replace(/"/g, '""')}"`,
    r.created_at ? new Date(r.created_at).toISOString() : '',
  ]));
  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `intl-interest-${Date.now()}.csv`;
  a.click(); URL.revokeObjectURL(url);
  Toast.success('CSV exported');
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='k') { e.preventDefault(); openAdminCmd(); }
  if (e.key==='Escape') { const ov=document.getElementById('adminCmdOverlay'); if(ov&&ov.style.display!=='none') closeAdminCmd(); }
});


/* ══════════════════════════════════════════════════════════════
   FEEDBACK / TESTIMONIALS REVIEW
══════════════════════════════════════════════════════════════ */
let _fbCurrentFilter = 'all';

async function loadFeedback(filter = 'all') {
  _fbCurrentFilter = filter;
  ['pending','approved','rejected','all'].forEach(f => {
    const btn = document.getElementById(`fbFilter${f.charAt(0).toUpperCase()+f.slice(1)}`);
    if (!btn) return;
    const active = f === filter;
    btn.style.fontWeight = active ? '800' : '';
    btn.style.background = active ? 'rgba(237,165,255,0.15)' : '';
    btn.style.color = active ? '#eda5ff' : '';
    btn.style.borderColor = active ? 'rgba(237,165,255,0.4)' : '';
  });
  const list = document.getElementById('feedbackList');
  if (!list) return;
  list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0">Loading…</p>';
  try {
    const _tr = await fetch('/api/testimonials', { headers: { Authorization: `Bearer ${Auth.getToken()}` } });
    if (!_tr.ok) { const e = await _tr.json().catch(()=>({})); throw new Error(e.error || `HTTP ${_tr.status}`); }
    const data = await _tr.json();
    let rows = data.data || [];
    if (filter !== 'all') rows = rows.filter(r => r.status === filter);

    const badge = document.getElementById('feedbackBadge');
    const pendingCount = (data.data || []).filter(r => r.status === 'pending').length;
    if (badge) { badge.textContent = pendingCount; badge.style.display = pendingCount ? '' : 'none'; }

    if (!rows.length) {
      list.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:40px 0">No ${filter === 'all' ? '' : filter+' '}feedback yet.</p>`;
      return;
    }

    const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
    const statusColor = { pending: '#fec24f', approved: '#10b981', rejected: '#ef4444' };

    list.innerHTML = rows.map(r => `
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:14px;padding:20px;position:relative">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#fec24f,#FF5229);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800;color:#1a1a1a;flex-shrink:0">${r.initials}</div>
            <div>
              <div style="font-weight:700;font-size:0.9rem">${r.first_name} ${r.last_name}</div>
              <div style="font-size:0.75rem;color:var(--text-muted)">${r.email}</div>
              <div style="font-size:0.78rem;color:#fec24f;letter-spacing:1px;margin-top:2px">${stars(r.rating)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:0.72rem;font-weight:700;padding:3px 10px;border-radius:20px;background:${statusColor[r.status]}20;color:${statusColor[r.status]};text-transform:uppercase">${r.status}</span>
            <span style="font-size:0.72rem;color:var(--text-muted)">${new Date(r.created_at).toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'})}</span>
          </div>
        </div>
        <p style="margin:14px 0 0;font-size:0.88rem;line-height:1.6;font-style:italic;color:var(--text-body)">"${r.body}"</p>
        ${r.product_label ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:6px">Product label: ${r.product_label}</div>` : ''}
        ${r.rejection_reason ? `<div style="font-size:0.75rem;color:#ef4444;margin-top:6px">Rejection reason: ${r.rejection_reason}</div>` : ''}
        ${r.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn--sm" style="background:#10b981;color:#fff;border:none" onclick="reviewFeedback('${r.id}','approved')">✓ Approve &amp; Publish</button>
          <button class="btn btn--sm btn--ghost" onclick="reviewFeedback('${r.id}','rejected')">✗ Reject</button>
        </div>` : r.status === 'approved' ? `
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <span style="font-size:0.72rem;color:#10b981;font-weight:700;align-self:center">✓ Live on homepage</span>
          <button class="btn btn--sm" style="background:#ef4444;color:#fff;border:none;margin-left:auto" onclick="reviewFeedback('${r.id}','remove')">🗑 Remove from homepage</button>
        </div>` : `
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn btn--sm" style="background:#10b981;color:#fff;border:none" onclick="reviewFeedback('${r.id}','approved')">✓ Approve &amp; Publish</button>
        </div>`}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p style="color:#ef4444;text-align:center;padding:40px 0">Failed to load feedback: ${err.message}</p>`;
  }
}

async function reviewFeedback(id, status) {
  let rejection_reason = null;
  let effectiveStatus = status;
  // "Remove from homepage" on an approved review — send back to pending so it can be re-reviewed
  if (status === 'remove') {
    effectiveStatus = 'pending';
  } else if (status === 'rejected') {
    rejection_reason = prompt('Reason for rejection (optional):') || null;
  }
  try {
    const _pr = await fetch(`/api/testimonials/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.getToken()}` }, body: JSON.stringify({ status: effectiveStatus, rejection_reason }) });
    if (!_pr.ok) { const e = await _pr.json().catch(()=>({})); throw new Error(e.error || `HTTP ${_pr.status}`); }
    const msg = effectiveStatus === 'approved' ? 'Testimonial published to homepage ✓' : effectiveStatus === 'pending' ? 'Removed from homepage — moved back to pending' : 'Testimonial rejected';
    Toast.success(msg);
    loadFeedback(_fbCurrentFilter);
  } catch (err) {
    Toast.error(err.message);
  }
}

/* ═══════════════════════════════════════════════════════════
   EMAIL LOGS
   ═══════════════════════════════════════════════════════════ */
let _emailLogsOffset = 0;
const _emailLogsLimit = 50;

const EMAIL_TYPE_LABELS = {
  welcome: 'Welcome', account_setup: 'Account Setup', password_reset: 'Password Reset',
  deposit_confirmed: 'Deposit Confirmed', investment_created: 'Investment Created',
  maturity_alert: 'Maturity Alert', withdrawal: 'Withdrawal', bank_approved: 'Bank Approved',
  monthly_statement: 'Monthly Statement', director_report: 'Director Report',
  kyc: 'KYC / FICA', support: 'Support', login_alert: 'Login Alert',
  gift: 'Gift', waitlist: 'Waitlist', staff_leave: 'Staff Leave', general: 'General',
};

async function loadEmailLogs(resetPage = true) {
  if (resetPage) _emailLogsOffset = 0;

  const search = (document.getElementById('emailLogSearch') || {}).value || '';
  const type   = (document.getElementById('emailLogType')   || {}).value || '';
  const status = (document.getElementById('emailLogStatus') || {}).value || '';
  const tbody  = document.getElementById('emailLogsList');
  const pager  = document.getElementById('emailLogsPager');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</td></tr>';

  try {
    const params = new URLSearchParams({ limit: _emailLogsLimit, offset: _emailLogsOffset });
    if (search) params.set('search', search);
    if (type)   params.set('type', type);
    if (status) params.set('status', status);

    const [logsRes, statsRes] = await Promise.all([
      API._fetch('GET', 'email-logs', null, Object.fromEntries(params)),
      _emailLogsOffset === 0 ? API._fetch('GET', 'email-logs/stats') : Promise.resolve(null),
    ]);

    // Stats chips — clickable to filter
    if (statsRes) {
      const statsEl = document.getElementById('emailLogStats');
      if (statsEl) {
        const t = statsRes.totals || {};
        const chip = (val, label, num, color) => {
          const numFmt = parseInt(num||0).toLocaleString('en-ZA');
          const style = `background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:10px;padding:10px 18px;display:flex;flex-direction:column;gap:2px;cursor:${val?'pointer':'default'};transition:box-shadow 0.15s` + (val ? ';user-select:none' : '');
          const onclick = val ? `onclick="_emailLogFilterStatus('${val}')"` : '';
          return `<div style="${style}" ${onclick} title="${val ? 'Click to filter by '+label : ''}">
            <div style="font-size:1.4rem;font-weight:800${color?';color:'+color:''}">${numFmt}</div>
            <div style="font-size:0.75rem;color:var(--text-muted)">${label}</div>
          </div>`;
        };
        statsEl.innerHTML =
          chip('', 'Total Emails', t.total, '') +
          chip('sent', 'Sent', t.sent, '#22c55e') +
          chip('failed', 'Failed', t.failed, '#ef4444') +
          (statsRes.byType||[]).slice(0,4).map(b =>
            chip('', EMAIL_TYPE_LABELS[b.type] || b.type, b.total, '')
          ).join('');
      }
    }

    // Table rows
    const logs = logsRes.data || [];
    if (!tbody) return;
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding:40px;text-align:center;color:var(--text-muted)">No emails found.</td></tr>';
      if (pager) pager.innerHTML = '';
      return;
    }

    const RETRYABLE_TYPES = new Set(['account_setup', 'password_reset']);
    tbody.innerHTML = logs.map(l => {
      const sent = l.sent_at ? new Date(l.sent_at).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : '—';
      const isFailed = l.status !== 'sent';
      const statusPill = isFailed
        ? `<span style="background:#fee2e2;color:#991b1b;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:600" title="${(l.error||'').replace(/"/g,"'")}">Failed</span>`
        : `<span style="background:#dcfce7;color:#166534;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:600">Sent</span>`;
      const typePill = `<span style="background:rgba(254,194,79,0.1);color:#b45309;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:600">${EMAIL_TYPE_LABELS[l.type] || l.type}</span>`;
      const resendBtn = isFailed && RETRYABLE_TYPES.has(l.type)
        ? `<button class="btn btn--sm btn--ghost" style="font-size:0.72rem;padding:3px 8px" onclick="retrySingleEmail('${l.id}', this)"><i class="fa-solid fa-paper-plane"></i> Resend</button>`
        : '';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:10px 12px">${l.to_email}</td>
        <td style="padding:10px 12px;max-width:320px;word-break:break-word">${l.subject || ''}</td>
        <td style="padding:10px 12px">${typePill}</td>
        <td style="padding:10px 12px">${statusPill}</td>
        <td style="padding:10px 12px;white-space:nowrap">${sent}</td>
        <td style="padding:10px 12px">${resendBtn}</td>
      </tr>`;
    }).join('');

    // Pager
    const total = logsRes.total || 0;
    const page  = Math.floor(_emailLogsOffset / _emailLogsLimit) + 1;
    const pages = Math.ceil(total / _emailLogsLimit);
    if (pager) {
      pager.innerHTML = `
        <span>${total.toLocaleString('en-ZA')} email${total !== 1 ? 's' : ''} · Page ${page} of ${pages || 1}</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn--sm btn--ghost" ${_emailLogsOffset === 0 ? 'disabled' : ''}
            onclick="_emailLogsOffset=Math.max(0,_emailLogsOffset-${_emailLogsLimit});loadEmailLogs(false)">← Prev</button>
          <button class="btn btn--sm btn--ghost" ${_emailLogsOffset + _emailLogsLimit >= total ? 'disabled' : ''}
            onclick="_emailLogsOffset+=${_emailLogsLimit};loadEmailLogs(false)">Next →</button>
        </div>`;
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:#ef4444">${err.message}</td></tr>`;
  }
}

function _emailLogFilterStatus(status) {
  const sel = document.getElementById('emailLogStatus');
  if (sel) { sel.value = status; loadEmailLogs(); }
}

async function exportEmailLogsCSV() {
  const search = (document.getElementById('emailLogSearch') || {}).value || '';
  const type   = (document.getElementById('emailLogType')   || {}).value || '';
  const status = (document.getElementById('emailLogStatus') || {}).value || '';
  Toast.info('Preparing export…');
  try {
    const params = { limit: 5000, offset: 0 };
    if (search) params.search = search;
    if (type)   params.type   = type;
    if (status) params.status = status;
    const res = await API._fetch('GET', 'email-logs', null, params);
    const rows = res.data || [];
    if (!rows.length) { Toast.info('No records to export.'); return; }
    const headers = ['Recipient', 'Subject', 'Type', 'Status', 'Sent At', 'Error'];
    const escape  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines   = [
      headers.map(escape).join(','),
      ...rows.map(l => [
        l.to_email, l.subject, EMAIL_TYPE_LABELS[l.type] || l.type,
        l.status, l.sent_at ? new Date(l.sent_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) : '',
        l.error || '',
      ].map(escape).join(',')),
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `email-logs-${new Date().toISOString().slice(0,10)}.csv` });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Toast.success(`Exported ${rows.length} rows.`);
  } catch (e) {
    Toast.error('Export failed: ' + e.message);
  }
}

async function retrySingleEmail(id, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
  try {
    await API._fetch('POST', `email-logs/${id}/retry`);
    Toast.success('Email resent successfully.');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-check"></i> Sent'; btn.style.color = '#22c55e'; }
  } catch (e) {
    Toast.error(e.message || 'Failed to resend.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Resend'; }
  }
}

async function retryAllFailedEmails() {
  const typeEl = document.getElementById('emailLogType');
  const type = typeEl?.value || '';
  const RETRYABLE = ['account_setup', 'password_reset'];
  if (type && !RETRYABLE.includes(type)) {
    return Toast.error(`Bulk resend is only supported for Account Setup and Password Reset emails.`);
  }
  const label = type ? (EMAIL_TYPE_LABELS[type] || type) : 'Account Setup';
  if (!await Confirm.ask(`Resend all failed ${label} emails?`, {
    body: 'This will send setup links to investors whose emails previously failed. Up to 500 at a time.',
    confirmLabel: 'Resend All',
  })) return;
  try {
    Toast.info('Processing… this may take a moment.');
    const res = await API._fetch('POST', 'email-logs/retry-failed', { type: type || 'account_setup' });
    Toast.success(`Done: ${res.sent} sent, ${res.errors} errors out of ${res.processed} processed.`);
    loadEmailLogs();
  } catch (e) {
    Toast.error(e.message || 'Bulk resend failed.');
  }
}

/* ═══════════════════════════════════════════════
   SEND EMAIL TO SINGLE INVESTOR
   ═══════════════════════════════════════════════ */
async function sendInvestorEmail(investorId, email, btn) {
  const subject = document.getElementById('invEmailSubject')?.value.trim();
  const message = document.getElementById('invEmailMessage')?.value.trim();
  if (!subject) { Toast.error('Subject is required'); return; }
  if (!message) { Toast.error('Message is required'); return; }
  await _withBtn(btn, async () => {
    try {
      await API._fetch('POST', 'admin/send-investor-email', { investor_id: investorId, subject, message });
      Toast.success(`Email sent to ${email}`);
      const subEl = document.getElementById('invEmailSubject');
      const msgEl = document.getElementById('invEmailMessage');
      if (subEl) subEl.value = '';
      if (msgEl) msgEl.value = '';
    } catch (e) { Toast.error('Failed to send email: ' + (e.message || 'error')); }
  });
}

/* ═══════════════════════════════════════════════
   VIEW AS INVESTOR (MAGIC LINK)
   ═══════════════════════════════════════════════ */
async function viewAsInvestor(investorId) {
  try {
    const res = await API._fetch('POST', 'auth/investor-magic-link', { investor_id: investorId });
    if (!res.ok || !res.url) throw new Error(res.error || 'No URL returned');
    window.open(res.url, '_blank', 'noopener,noreferrer');
    Toast.info('Portal opened in a new tab — link expires in 15 minutes');
  } catch (e) { Toast.error('Failed to generate magic link: ' + (e.message || 'error')); }
}

/* ═══════════════════════════════════════════════
   INVESTOR STATEMENTS
   ═══════════════════════════════════════════════ */
async function _generateAdminTaxCert(investorId) {
  const year = parseInt(document.getElementById('adminTaxCertYear')?.value || new Date().getFullYear());
  const btn  = document.getElementById('adminTaxCertBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…'; }
  try {
    const data = await API._fetch('GET', 'admin/tax-cert', null, { investor_id: investorId, year });
    _openAdminTaxCertWindow(data);
  } catch (e) {
    Toast.error('Failed to generate certificate: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

function _openAdminTaxCertWindow(data) {
  const { investor: inv, taxYear, returns, deposits, totalReturns, totalDeposits, from, to } = data;

  const fmt = n => 'R ' + parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = s => s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const certNo = `SVCRC-${taxYear}-${String(inv.id).replace(/\D/g,'').slice(-6)}`;
  const issuedAt = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const fromLabel = new Date(from).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const toLabel   = new Date(to).toLocaleDateString('en-ZA',   { day: 'numeric', month: 'long', year: 'numeric' });
  const fullAddr  = [inv.street_address, inv.suburb, inv.address, inv.postal_code, inv.province].filter(Boolean).join(', ');

  const returnsRows = returns.map(t => `
    <tr>
      <td>${fmtDate(t.created_at)}</td>
      <td>${esc(t.description || (t.type === 'return' ? 'Investment return' : 'Payout'))}</td>
      <td class="amt">${fmt(Math.abs(parseFloat(t.amount||0)))}</td>
    </tr>`).join('');

  const depositsRows = deposits.map(t => `
    <tr>
      <td>${fmtDate(t.created_at)}</td>
      <td>${esc(t.description || 'Client deposit')}</td>
      <td class="amt">${fmt(Math.abs(parseFloat(t.amount||0)))}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>SV Capital Investment Income Reference ${taxYear-1}/${taxYear}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:13px}
@page{size:A4 portrait;margin:16mm 20mm}
@media print{.no-print{display:none!important}.wrap{margin-top:0!important}}
.no-print{position:fixed;top:0;left:0;right:0;background:#303030;padding:9px 20px;display:flex;justify-content:space-between;align-items:center;z-index:99;gap:10px}
.no-print span{color:#fff;font-size:12px;font-weight:600}
.no-print button{background:#eda5ff;color:#111;border:none;padding:7px 18px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}
.wrap{max-width:740px;margin:56px auto 32px;padding:32px}
/* Header */
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:18px;border-bottom:3px solid #303030;margin-bottom:22px}
.hdr-left h1{font-size:16px;font-weight:700;color:#303030;margin-bottom:2px}
.hdr-left p{font-size:11px;color:#666;margin-top:3px}
.cert-badge{text-align:right;font-size:10px;color:#555;line-height:1.6}
.cert-badge strong{display:block;font-size:12px;color:#303030;font-weight:700}
/* Warning */
.warning{background:#fff8e1;border:1.5px solid #f59e0b;border-radius:6px;padding:10px 14px;margin-bottom:20px;font-size:11px;color:#78350f;display:flex;gap:8px;align-items:flex-start}
.warning strong{display:block;margin-bottom:2px}
/* Summary boxes */
.summary{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:24px}
.sum-box{border-radius:8px;padding:16px 18px;text-align:center}
.sum-box.green{background:#f0fdf4;border:1.5px solid #22c55e}
.sum-box.blue{background:#eff6ff;border:1.5px solid #3b82f6}
.sum-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
.sum-box.green .sum-lbl{color:#166534}
.sum-box.blue  .sum-lbl{color:#1e40af}
.sum-amt{font-size:22px;font-weight:800}
.sum-box.green .sum-amt{color:#15803d}
.sum-box.blue  .sum-amt{color:#1d4ed8}
.sum-period{font-size:10px;margin-top:3px}
.sum-box.green .sum-period{color:#166534}
.sum-box.blue  .sum-period{color:#1e40af}
/* Investor details */
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#374151;margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid #e5e7eb}
.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;margin-bottom:22px;font-size:12px}
.details-grid dt{color:#6b7280;font-weight:600}
.details-grid dd{color:#111;font-weight:500}
/* Tables */
table{width:100%;border-collapse:collapse;margin-bottom:22px;font-size:12px}
thead tr{background:#f1f5f9}
th{padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151}
td{padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#374151}
td.amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
tr.total-row td{border-top:2px solid #e5e7eb;border-bottom:none;font-weight:700;background:#f8fafc}
tr.total-row td.amt{color:#111}
.empty{text-align:center;padding:16px;background:#f8fafc;border-radius:6px;color:#9ca3af;font-size:12px;margin-bottom:22px}
/* Footer */
.footer{border-top:1px solid #e5e7eb;padding-top:14px;font-size:10px;color:#6b7280;line-height:1.7;margin-top:8px}
.footer strong{color:#374151}
.stamp{display:inline-block;border:2px solid #303030;color:#303030;padding:5px 12px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:12px}
</style></head><body>
<div class="no-print">
  <span>SV Capital — Investment Income Reference &nbsp;·&nbsp; ${taxYear-1} / ${taxYear} &nbsp;·&nbsp; ${esc(inv.first_name)} ${esc(inv.last_name)}</span>
  <button onclick="window.print()">Print / Save PDF</button>
</div>
<div class="wrap">
  <div class="hdr">
    <div class="hdr-left">
      <h1>SV Capital (Pty) Ltd</h1>
      <p>FSCA Regulated Financial Services Provider</p>
      <p style="font-size:10px;color:#9ca3af;margin-top:4px">Ref No: ${certNo}</p>
    </div>
    <div class="cert-badge">
      <strong>Investment Income Reference</strong>
      Tax Year: 1 March ${taxYear-1} – 28 February ${taxYear}<br>
      Issued: ${issuedAt}
    </div>
  </div>

  <div class="warning">
    <span style="font-size:16px">⚠</span>
    <div><strong>For reference purposes only — not an official SARS tax certificate.</strong>
    This document is provided to assist the client in preparing their tax return. It has not been submitted to SARS and does not replace an official IT3(b) certificate.</div>
  </div>

  <div class="summary">
    <div class="sum-box green">
      <div class="sum-lbl">Total Returns Earned</div>
      <div class="sum-amt">${fmt(totalReturns)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
    <div class="sum-box blue">
      <div class="sum-lbl">Total Deposits Made</div>
      <div class="sum-amt">${fmt(totalDeposits)}</div>
      <div class="sum-period">${fromLabel} – ${toLabel}</div>
    </div>
  </div>

  <div class="section-title">Investor Details</div>
  <dl class="details-grid">
    <dt>Full Name</dt><dd>${esc(inv.first_name)} ${esc(inv.last_name)}</dd>
    <dt>Investor Account</dt><dd>${esc(inv.id)}</dd>
    <dt>Email Address</dt><dd>${esc(inv.email || '—')}</dd>
    <dt>SA ID / Passport</dt><dd>${esc(inv.id_number || '—')}</dd>
    ${fullAddr ? `<dt>Address</dt><dd>${esc(fullAddr)}</dd>` : ''}
  </dl>

  <div class="section-title" style="color:#166534">Returns Earned</div>
  ${returns.length ? `<table>
    <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${returnsRows}
      <tr class="total-row"><td colspan="2">TOTAL RETURNS EARNED</td><td class="amt">${fmt(totalReturns)}</td></tr>
    </tbody>
  </table>` : `<div class="empty">No returns recorded for this tax year.</div>`}

  <div class="section-title" style="color:#1e40af">Deposits Made</div>
  ${deposits.length ? `<table>
    <thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>
      ${depositsRows}
      <tr class="total-row"><td colspan="2">TOTAL DEPOSITS MADE</td><td class="amt">${fmt(totalDeposits)}</td></tr>
    </tbody>
  </table>` : `<div class="empty">No deposits recorded for this tax year.</div>`}

  <div class="footer">
    <strong>SV Capital (Pty) Ltd</strong> — FSCA Regulated Financial Services Provider.<br>
    This document is generated for client reference only and does not constitute an official SARS IT3(b) interest income certificate.
    Returns shown are investment returns and payouts credited to the investor account in the tax year ${taxYear-1}/${taxYear}
    (1 March ${taxYear-1} to 28 February ${taxYear}).<br>
    Deposits shown are funds deposited into the investor's SV Capital account during the same period.<br>
    <strong>Ref:</strong> ${certNo} &nbsp;·&nbsp; <strong>Issued:</strong> ${issuedAt}<br>
    <div class="stamp">SV Capital</div>
  </div>
</div>
</body></html>`;

  const win = window.open('', '_blank', 'width=860,height=960');
  if (!win) { Toast.error('Pop-up blocked — allow pop-ups for this site and try again'); return; }
  win.document.write(html);
  win.document.close();
}

async function _loadInvestorStatements(investorId) {
  const el = document.getElementById('invStatementsList');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></div>';
  try {
    const res = await API._fetch('GET', 'admin/investor-statements', null, { investor_id: investorId });
    const stmts = res.statements || [];
    if (!stmts.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-file-circle-xmark" style="font-size:2rem;display:block;margin-bottom:10px;opacity:0.3"></i>No statements generated yet</div>';
      return;
    }
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    el.innerHTML = `<div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Period</th><th>Generated</th><th></th></tr></thead>
        <tbody>${stmts.map(s => `<tr>
          <td class="td-strong">${monthNames[s.period_month] || s.period_month} ${s.period_year}</td>
          <td class="td-muted">${Utils.date(s.created_at)}</td>
          <td><button class="btn btn--secondary btn--sm" onclick='downloadInvestorStatement(${JSON.stringify(s.id)},${JSON.stringify(investorId)},${s.period_year},${s.period_month},this)'><i class="fa-solid fa-download"></i> PDF</button></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#ef4444;font-size:0.82rem"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load statements</div>';
  }
}

async function downloadInvestorStatement(stmtId, investorId, year, month, btn) {
  await _withBtn(btn, async () => {
    try {
      const token = localStorage.getItem('svc_token');
      const r = await fetch(`/api/admin/investor-statements/${encodeURIComponent(stmtId)}/pdf?investor_id=${encodeURIComponent(investorId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SVC-Statement-${year}-${String(month).padStart(2,'0')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { Toast.error('Failed to download: ' + e.message); }
  });
}

async function _generateAccountStatement(investorId) {
  const from = document.getElementById('stmtFromDate')?.value;
  const to   = document.getElementById('stmtToDate')?.value;
  if (!from || !to) { Toast.error('Please select a date range'); return; }
  const btn  = document.getElementById('stmtGenBtn');
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…'; }
  try {
    const data = await API._fetch('GET', 'admin/account-statement', null, { investor_id: investorId, from, to });
    _openAccountStatementWindow(data);
  } catch (e) {
    Toast.error('Failed to generate statement: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

function _openAccountStatementWindow(data) {
  const { investor: inv, period, investments } = data;

  const fmt = n => 'R ' + Math.abs(parseFloat(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = s => s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const fromLabel = new Date(period.from).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const toLabel   = new Date(period.to).toLocaleDateString('en-ZA',   { day: 'numeric', month: 'long', year: 'numeric' });
  const issuedAt  = new Date().toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const stmtRef   = 'SVCAS-' + new Date().getFullYear() + '-' + (String(inv.id).replace(/\D/g,'').slice(-6) || String(inv.id).slice(-6).toUpperCase());
  const fullAddr  = [inv.street_address, inv.suburb, inv.address, inv.postal_code, inv.province].filter(Boolean).join(', ');

  const PROD_LABELS  = { cattle:'Cattle Investment', short_term:'Short-Term Investment', solar:'Solar Investment' };
  const INSTR_LABELS = { reinvest:'Reinvest', withdraw:'Withdraw', partial_withdraw:'Partial Withdraw', rollover:'Roll Over' };
  const STATUS_CFG   = {
    active:    { cls:'sb-active',    lbl:'Active'    },
    pending:   { cls:'sb-pending',   lbl:'Pending'   },
    matured:   { cls:'sb-matured',   lbl:'Matured'   },
    paid_out:  { cls:'sb-paidout',   lbl:'Paid Out'  },
    cancelled: { cls:'sb-cancelled', lbl:'Cancelled' },
  };

  const activeInvests  = investments.filter(i => ['active','pending'].includes(i.status));
  const maturedInvests = investments.filter(i => ['matured','paid_out'].includes(i.status));
  const _sortDesc = (a, b) => new Date(b.maturity_date || b.pool_end_date || 0) - new Date(a.maturity_date || a.pool_end_date || 0);
  activeInvests.sort(_sortDesc);
  maturedInvests.sort(_sortDesc);

  const activeHead  = '<thead><tr><th>Date</th><th>Pool Name</th><th>Product</th><th class="num">Capital</th><th>Pool Start</th><th>Pool End</th><th>Status</th></tr></thead>';
  const maturedHead = '<thead><tr><th>Date</th><th>Pool Name</th><th>Product</th><th class="num">Capital</th><th class="num">Return</th><th class="num">Rand Return</th><th>Pool Start</th><th>Pool End</th><th>Maturity Instruction</th><th>Status</th></tr></thead>';

  const getInstr = i => {
    const raw = i.maturity_instruction || i.payout_option || '';
    return { reinvest:'Reinvest', withdraw:'Withdraw', partial_withdraw:'Partial Withdraw', rollover:'Roll Over' }[raw] || (raw ? raw.replace(/_/g,' ') : '—');
  };
  const getRate = i => {
    const r = parseFloat(i.annual_rate);
    return r ? (r * 100).toFixed(2) + '%' : '—';
  };
  const calcRandReturn = i => {
    const principal = parseFloat(i.amount) || 0;
    const rate      = parseFloat(i.annual_rate) || 0;
    const startMs   = new Date(i.start_date || i.created_at).getTime();
    const endMs     = new Date(i.maturity_date || i.pool_end_date).getTime();
    if (!principal || !rate || isNaN(startMs) || isNaN(endMs) || endMs <= startMs)
      return parseFloat(i.actual_return || i.expected_return || 0);
    const days = (endMs - startMs) / 86400000;
    return principal * rate * (days / 365);
  };

  const buildActiveRows = rows => rows.map(i => {
    const cfg  = STATUS_CFG[i.status] || { cls:'sb-pending', lbl: i.status || '' };
    const prod = PROD_LABELS[i.product_type] || i.pool_name || '—';
    return '<tr>' +
      '<td>' + fmtDate(i.start_date || i.created_at) + '</td>' +
      '<td>' + esc(i.pool_name || '—') + '</td>' +
      '<td>' + esc(prod) + '</td>' +
      '<td class="num">' + fmt(i.amount) + '</td>' +
      '<td>' + fmtDate(i.pool_start_date) + '</td>' +
      '<td>' + fmtDate(i.pool_end_date) + '</td>' +
      '<td><span class="sb ' + cfg.cls + '">' + cfg.lbl + '</span></td>' +
      '</tr>';
  }).join('');

  const buildMaturedRows = rows => rows.map(i => {
    const cfg  = STATUS_CFG[i.status] || { cls:'sb-pending', lbl: i.status || '' };
    const prod = PROD_LABELS[i.product_type] || i.pool_name || '—';
    return '<tr>' +
      '<td>' + fmtDate(i.start_date || i.created_at) + '</td>' +
      '<td>' + esc(i.pool_name || '—') + '</td>' +
      '<td>' + esc(prod) + '</td>' +
      '<td class="num">' + fmt(i.amount) + '</td>' +
      '<td class="num earn">' + getRate(i) + '</td>' +
      '<td class="num earn">' + fmt(calcRandReturn(i)) + '</td>' +
      '<td>' + fmtDate(i.pool_start_date) + '</td>' +
      '<td>' + fmtDate(i.pool_end_date) + '</td>' +
      '<td>' + esc(getInstr(i)) + '</td>' +
      '<td><span class="sb ' + cfg.cls + '">' + cfg.lbl + '</span></td>' +
      '</tr>';
  }).join('');

  const emptyActive  = '<tr><td colspan="7" class="empty-row">No active investments in this period</td></tr>';
  const emptyMatured = '<tr><td colspan="10" class="empty-row">No matured investments in this period</td></tr>';

  // Build CSV for download button
  const csvRows = [
    ['Date','Pool Name','Product','Capital','Return','Rand Return','Pool Start Date','Pool End Date','Maturity Instruction','Status']
  ].concat(investments.map(i => [
    fmtDate(i.start_date || i.created_at),
    i.pool_name || '',
    PROD_LABELS[i.product_type] || i.pool_name || '',
    parseFloat(i.amount || 0).toFixed(2),
    getRate(i),
    calcRandReturn(i).toFixed(2),
    fmtDate(i.pool_start_date),
    fmtDate(i.pool_end_date),
    getInstr(i),
    (STATUS_CFG[i.status] || {}).lbl || i.status || '',
  ]));
  const csvEsc  = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csvData = csvRows.map(r => r.map(csvEsc).join(',')).join('\r\n');
  const csvB64  = btoa(unescape(encodeURIComponent(csvData)));
  const csvName = 'SVC-Statement-' + inv.id + '-' + period.from.slice(0,10) + '-to-' + period.to.slice(0,10) + '.csv';

  const activeRows  = activeInvests.length  ? buildActiveRows(activeInvests)   : emptyActive;
  const maturedRows = maturedInvests.length ? buildMaturedRows(maturedInvests) : emptyMatured;
  const aCnt = activeInvests.length;
  const mCnt = maturedInvests.length;

  const _logoUrl = window.location.origin + '/assets/sv-capital-logo-horizontal-white-text.png';

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="UTF-8">',
    '<title>SV Capital — Investment Statement ' + fromLabel + ' to ' + toLabel + '</title>',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:Arial,Helvetica,sans-serif;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:12px}',
    '@page{size:A4 landscape;margin:12mm 14mm}',
    '@media print{.no-print{display:none!important}.wrap{margin-top:0!important}}',
    '.no-print{position:fixed;top:0;left:0;right:0;background:#1f2937;padding:9px 20px;display:flex;justify-content:space-between;align-items:center;z-index:99;gap:10px;flex-wrap:wrap}',
    '.no-print span{color:#fff;font-size:12px;font-weight:600;flex:1}',
    '.no-print .btn-row{display:flex;gap:8px}',
    '.no-print button{border:none;padding:7px 16px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer}',
    '.btn-print{background:#eda5ff;color:#111}.btn-csv{background:#22c55e;color:#fff}',
    '.wrap{max-width:1100px;margin:52px auto 32px;padding:24px 30px;border-top:5px solid #eda5ff}',
    '.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px solid #1f2937;margin-bottom:18px}',
    '.hdr-brand h1{font-size:17px;font-weight:800;color:#1f2937}',
    '.hdr-brand p{font-size:10px;color:#6b7280;margin-top:2px}',
    '.hdr-right{text-align:right}',
    '.stmt-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin-bottom:3px}',
    '.stmt-title{font-size:20px;font-weight:800;color:#1f2937;margin-bottom:4px}',
    '.stmt-meta{font-size:10px;color:#6b7280;line-height:1.6}',
    '.info-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}',
    '.info-box{border:1.5px solid #e5e7eb;border-radius:7px;padding:12px 14px}',
    '.info-box-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#9ca3af;margin-bottom:7px}',
    '.info-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11px}',
    '.info-grid dt{color:#6b7280;font-weight:600;white-space:nowrap}',
    '.info-grid dd{color:#111;font-weight:500}',
    '.sec-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:6px 10px;border-radius:5px;margin:18px 0 8px}',
    '.sec-hdr.active-hdr{background:#dcfce7;color:#166534;border-left:3px solid #22c55e}',
    '.sec-hdr.matured-hdr{background:#dbeafe;color:#1e40af;border-left:3px solid #3b82f6}',
    'table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:11px}',
    'thead tr{background:#f1f5f9}',
    'th{padding:6px 8px;text-align:left;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151;white-space:nowrap}',
    'th.num{text-align:right}',
    'td{padding:7px 8px;border-bottom:1px solid #f1f5f9;color:#374151;vertical-align:middle}',
    'td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    'td.earn{color:#15803d;font-weight:700}',
    'tr:last-child td{border-bottom:none}',
    '.empty-row{text-align:center;padding:18px;color:#9ca3af;background:#fafafa;font-style:italic}',
    '.sb{display:inline-block;padding:2px 7px;border-radius:3px;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}',
    '.sb-active{background:#dcfce7;color:#166534}.sb-matured{background:#dbeafe;color:#1e40af}',
    '.sb-pending{background:#fef3c7;color:#92400e}.sb-paidout{background:#f3e8ff;color:#7e22ce}',
    '.sb-cancelled{background:#f1f5f9;color:#6b7280}',
    '.note{font-size:9.5px;color:#9ca3af;margin-bottom:14px}',
    '.footer{border-top:1px solid #e5e7eb;padding-top:11px;font-size:9px;color:#6b7280;line-height:1.7;margin-top:8px}',
    '.footer strong{color:#374151}',
    '.stamp{display:inline-block;border:2px solid #eda5ff;color:#eda5ff;padding:4px 11px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-top:10px}',
    '</style></head><body>',
    '<div class="no-print">',
    '  <span>SV Capital &mdash; Investment Statement &middot; ' + esc(inv.first_name) + ' ' + esc(inv.last_name) + ' &middot; ' + fromLabel + ' &ndash; ' + toLabel + '</span>',
    '  <div class="btn-row">',
    '    <button class="btn-csv" onclick="(function(){var a=document.createElement(\'a\');a.href=\'data:text/csv;base64,' + csvB64 + '\';a.download=\'' + csvName + '\';a.click()})()">&#11123; Download CSV</button>',
    '    <button class="btn-print" onclick="window.print()">&#128438; Print / Save PDF</button>',
    '  </div>',
    '</div>',
    '<div class="wrap">',
    '  <div class="hdr">',
    '    <div class="hdr-brand">',
    '      <div style="background:#1f2937;padding:10px 18px;border-radius:8px;display:inline-block"><img src="' + _logoUrl + '" style="height:46px;width:auto;display:block" alt="SV Capital"></div>',
    '      <p style="font-size:10px;color:#6b7280;margin-top:7px">FSCA Regulated Financial Services Provider &middot; <span style="color:#eda5ff;font-weight:600">www.svcapital.co.za</span></p>',
    '    </div>',
    '    <div class="hdr-right"><div class="stmt-lbl">Document Type</div><div class="stmt-title">Investment Statement</div>',
    '    <div class="stmt-meta">Ref: <strong>' + stmtRef + '</strong><br>Period: ' + fromLabel + ' &ndash; ' + toLabel + '<br>Issued: ' + issuedAt + '</div></div>',
    '  </div>',
    '  <div class="info-row">',
    '    <div class="info-box"><div class="info-box-title">Client Details</div><dl class="info-grid">',
    '      <dt>Full Name</dt><dd>' + esc(inv.first_name) + ' ' + esc(inv.last_name) + '</dd>',
    '      <dt>Investor ID</dt><dd>' + esc(inv.id) + '</dd>',
    '      <dt>Email</dt><dd>' + esc(inv.email || '—') + '</dd>',
    '      <dt>SA ID / Passport</dt><dd>' + esc(inv.id_number || '—') + '</dd>',
    (inv.mobile ? '      <dt>Mobile</dt><dd>' + esc(inv.mobile) + '</dd>' : ''),
    (fullAddr   ? '      <dt>Address</dt><dd>' + esc(fullAddr) + '</dd>'  : ''),
    '    </dl></div>',
    '    <div class="info-box"><div class="info-box-title">Statement Details</div><dl class="info-grid">',
    '      <dt>Period From</dt><dd>' + fromLabel + '</dd>',
    '      <dt>Period To</dt><dd>' + toLabel + '</dd>',
    '      <dt>Reference</dt><dd style="font-family:monospace;font-size:10px">' + stmtRef + '</dd>',
    '      <dt>Issued</dt><dd>' + issuedAt + '</dd>',
    '      <dt>Active Pools</dt><dd>' + aCnt + '</dd>',
    '      <dt>Matured Pools</dt><dd>' + mCnt + '</dd>',
    '    </dl></div>',
    '  </div>',
    '  <div class="sec-hdr active-hdr">Active Pools &mdash; ' + aCnt + ' investment' + (aCnt !== 1 ? 's' : '') + '</div>',
    '  <table>' + activeHead + '<tbody>' + activeRows + '</tbody></table>',
    '  <div class="sec-hdr matured-hdr">Matured Pools &mdash; ' + mCnt + ' investment' + (mCnt !== 1 ? 's' : '') + '</div>',
    '  <table>' + maturedHead + '<tbody>' + maturedRows + '</tbody></table>',
    '  <p class="note">* Expected return shown where actual return has not yet been recorded.</p>',
    '  <div class="footer">',
    '    <strong>SV Capital (Pty) Ltd</strong> &mdash; FSCA Regulated Financial Services Provider.<br>',
    '    This investment statement is prepared for <strong>' + esc(inv.first_name) + ' ' + esc(inv.last_name) + '</strong> (Account: ' + esc(inv.id) + ') and covers the period ' + fromLabel + ' to ' + toLabel + '. All amounts are in South African Rand (ZAR).<br>',
    '    Returns marked * represent projected figures based on the pool rate; actual returns are confirmed at maturity. This document does not constitute a tax certificate.<br>',
    '    <strong>Ref:</strong> ' + stmtRef + ' &middot; <strong>Issued:</strong> ' + issuedAt + ' &middot; <strong>Generated by:</strong> SV Capital Admin Console<br>',
    '    <div class="stamp">SV Capital (Pty) Ltd &mdash; www.svcapital.co.za</div>',
    '  </div>',
    '</div>',
    '</body></html>',
  ].join('\n');

  const win = window.open('', '_blank', 'width=1100,height=900');
  if (!win) { Toast.error('Pop-up blocked — allow pop-ups for this site and try again'); return; }
  win.document.write(html);
  win.document.close();
}


/* ═══════════════════════════════════════════════
   POOL CLOSE-OUT WIZARD
   ═══════════════════════════════════════════════ */
function openPoolCloseoutWizard(poolId) {
  const pool = STATE.pools.find(p => p.id === poolId);
  if (!pool) return;
  const investors = (STATE.investments || []).filter(i => i.pool_id === poolId && i.status === 'active');
  const totalAmt  = investors.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const modal = document.getElementById('poolCloseoutModal');
  if (!modal) { Toast.error('Close-out modal not found — refresh the page'); return; }
  document.getElementById('closeoutPoolId').value   = poolId;
  document.getElementById('closeoutPoolName').textContent = pool.name;
  document.getElementById('closeoutInvCount').textContent = `${investors.length} investor${investors.length !== 1 ? 's' : ''}`;
  document.getElementById('closeoutTotalAmt').textContent = Utils.rand(totalAmt);
  document.getElementById('closeoutMaturityDate').textContent = Utils.date(pool.maturity_date || pool.end_date);
  document.getElementById('closeoutActualRate').value = pool.actual_rate ? (pool.actual_rate * 100).toFixed(4) : '';
  document.getElementById('closeoutNotify').checked = true;
  Modal.open('poolCloseoutModal');
}

async function savePoolCloseout(btn) {
  const poolId    = document.getElementById('closeoutPoolId').value;
  const rateInput = document.getElementById('closeoutActualRate').value.trim();
  const notify    = document.getElementById('closeoutNotify')?.checked;
  if (!rateInput) { Toast.error('Actual rate is required'); return; }
  const rate = parseFloat(rateInput) / 100;
  if (isNaN(rate) || rate < 0 || rate > 2) { Toast.error('Enter rate as a percentage (e.g. 15.61)'); return; }

  await _withBtn(btn, async () => {
    try {
      await API.pools.update(poolId, { status: 'matured', actual_rate: rate });
      if (notify) {
        try {
          await API._fetch('POST', 'admin/broadcast', {
            target: 'pool',
            pool_id: poolId,
            template: 'maturity_notification',
            subject: 'Your investment has matured',
            message: `Your investment has matured at an actual return rate of ${(rate * 100).toFixed(2)}%. Please log in to your portal to view your maturity instruction options.`,
          });
        } catch (_) {}
      }
      Toast.success('Pool finalised — status set to matured');
      Modal.close('poolCloseoutModal');
      await loadPools();
    } catch (e) { Toast.error('Failed to finalise pool: ' + (e.message || 'error')); }
  });
}

/* ═══════════════════════════════════════════════
   UPCOMING MATURITIES
   ═══════════════════════════════════════════════ */
async function loadUpcomingMaturities() {
  const el = document.getElementById('upcomingMaturitiesBody');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try {
    if (!STATE.pools.length) STATE.pools = (await API.pools.list({ limit: 5000 })).data || [];
    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 86400000);
    const upcoming = STATE.pools
      .filter(p => {
        const mat = p.maturity_date || p.end_date;
        if (!mat || p.status === 'paid_out') return false;
        const d = new Date(mat);
        return d >= now && d <= in90;
      })
      .sort((a, b) => new Date(a.maturity_date || a.end_date) - new Date(b.maturity_date || b.end_date));

    if (!upcoming.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>No pools maturing in the next 90 days</div>';
      return;
    }
    el.innerHTML = `<div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Pool</th><th>Partner</th><th>Investors</th><th>Maturity Date</th><th>Days Left</th><th>Status</th><th></th></tr></thead>
        <tbody>${upcoming.map(p => {
          const mat = new Date(p.maturity_date || p.end_date);
          const daysLeft = Math.ceil((mat - now) / 86400000);
          const urgency  = daysLeft <= 7 ? '#ef4444' : daysLeft <= 30 ? '#fec24f' : '#22c55e';
          const pi = Utils.productInfo(p.product_type);
          return `<tr>
            <td class="td-strong">${_esc(p.name)}</td>
            <td class="td-muted">${_esc(p.partner_name||'—')}</td>
            <td style="font-weight:700;color:var(--gold)">${p.live_investor_count ?? p.investor_count ?? 0}</td>
            <td class="td-muted">${Utils.date(p.maturity_date || p.end_date)}</td>
            <td><span style="font-weight:800;color:${urgency}">${daysLeft}d</span></td>
            <td>${Utils.statusBadge(p.status)}</td>
            <td>
              ${p.status === 'matured' ? `<button class="btn btn--success btn--sm" onclick="openPoolCloseoutWizard('${p.id}')"><i class="fa-solid fa-check-circle"></i> Close Out</button>` : ''}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div style="margin-top:12px;font-size:0.75rem;color:var(--text-muted);text-align:right">${upcoming.length} pool${upcoming.length!==1?'s':''} maturing within 90 days</div>`;
  } catch (e) { el.innerHTML = `<div style="color:#ef4444;padding:16px;font-size:0.82rem">Failed to load: ${e.message}</div>`; }
}

/* ═══════════════════════════════════════════════
   FAILED LOGINS VIEW
   ═══════════════════════════════════════════════ */
async function loadFailedLogins() {
  const el = document.getElementById('failedLoginsBody');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try {
    const res = await API.list('audit_events', {
      limit: 200,
      order: 'created_at.desc',
    });
    const events = (res.data || []).filter(e => e.event_type === 'user.login_failed' || e.event_type === 'user.login_locked');
    if (!events.length) {
      el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-shield-check" style="color:#22c55e;font-size:2rem;display:block;margin-bottom:10px"></i>No failed login events recorded</div>';
      return;
    }
    el.innerHTML = `<div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Time</th><th>Email</th><th>Event</th><th>IP</th><th>Attempts</th></tr></thead>
        <tbody>${events.map(e => {
          const meta = (() => { try { return typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {}); } catch (_) { return {}; } })();
          const isLock = e.event_type === 'user.login_locked';
          return `<tr>
            <td class="td-muted" style="font-size:0.78rem">${Utils.date(e.created_at)}</td>
            <td class="td-strong" style="font-size:0.82rem">${_esc(e.user_email || e.actor_id || '—')}</td>
            <td><span class="badge ${isLock ? 'badge--red' : 'badge--yellow'}">${isLock ? 'Account Locked' : 'Failed Login'}</span></td>
            <td class="td-muted" style="font-family:monospace;font-size:0.78rem">${_esc(e.ip_address || '—')}</td>
            <td style="font-weight:700;color:${isLock?'#ef4444':'#fec24f'}">${meta.attempts || '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div style="margin-top:12px;font-size:0.75rem;color:var(--text-muted)">${events.length} event${events.length!==1?'s':''} · Showing most recent 200 audit records filtered for login failures</div>`;
  } catch (e) { el.innerHTML = `<div style="color:#ef4444;padding:16px;font-size:0.82rem">Failed to load: ${e.message}</div>`; }
}

/* ═══════════════════════════════════════════════
   STAFF PERMISSIONS (RBAC)
   ═══════════════════════════════════════════════ */
async function loadStaffPermissions() {
  const el = document.getElementById('staffPermissionsBody');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try {
    const res = await API.list('users', { limit: 200 });
    const staff = (res.data || []).filter(u => ['admin','director','fund_manager','ifa','staff'].includes(u.role));
    if (!staff.length) {
      el.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:0.85rem">No staff accounts found</div>';
      return;
    }
    const roleColor = { admin:'#eda5ff', director:'#ef4444', fund_manager:'#fec24f', ifa:'#22c55e', staff:'#60a5fa', investor:'#7a92a8' };
    el.innerHTML = `<div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Name / Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Last Login</th></tr></thead>
        <tbody>${staff.map(u => {
          const color = roleColor[u.role] || '#7a92a8';
          const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
          return `<tr>
            <td>
              <div class="td-strong">${_esc(name)}</div>
              <div class="td-muted" style="font-size:0.72rem">${_esc(u.email)}</div>
            </td>
            <td><span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${_esc(u.role)}</span></td>
            <td>${Utils.statusBadge(u.status || 'active')}</td>
            <td>${u.totp_enabled ? '<span class="badge badge--green" style="font-size:0.68rem"><i class="fa-solid fa-shield-check"></i> On</span>' : '<span class="badge badge--grey" style="font-size:0.68rem">Off</span>'}</td>
            <td class="td-muted" style="font-size:0.78rem">${u.last_login ? Utils.date(u.last_login) : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div style="margin-top:12px;font-size:0.75rem;color:var(--text-muted)">${staff.length} staff account${staff.length!==1?'s':''}</div>`;
  } catch (e) { el.innerHTML = `<div style="color:#ef4444;padding:16px;font-size:0.82rem">Failed to load staff: ${e.message}</div>`; }
}

/* ══════════════════════════════════════════════════════════════
   SSE — Real-time Admin Notifications
══════════════════════════════════════════════════════════════ */
function _initSSE() {
  if (!window.EventSource) return;
  const raw = localStorage.getItem('staffSession');
  let token = '';
  try { const s = JSON.parse(raw || '{}'); if (s.token) token = s.token; } catch (_) {}
  if (!token) { try { token = localStorage.getItem('svc_staff_token') || ''; } catch (_) {} }

  const url = `/api/events/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  let delay = 3000;

  function connect() {
    const src = new EventSource(url);

    src.addEventListener('kyc_submitted', e => {
      try {
        const d = JSON.parse(e.data);
        Toast.info(`KYC uploaded: ${d.investor_name || 'An investor'} submitted documents`, 9000, {
          action: { label: 'Review', callback: () => { const btn = document.querySelector('[data-view=kyc]'); if (btn) navigate('kyc', btn); } }
        });
        const badge = document.getElementById('kycBadge');
        if (badge) badge.textContent = (parseInt(badge.textContent, 10) || 0) + 1;
      } catch (_) {}
    });

    src.addEventListener('withdrawal_requested', e => {
      try {
        const d = JSON.parse(e.data);
        const amt = d.amount ? ` — R${parseFloat(d.amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}` : '';
        Toast.info(`Withdrawal request: ${d.investor_name || 'Investor'}${amt}`, 9000, {
          action: { label: 'Review', callback: () => { const btn = document.querySelector('[data-view=withdrawals]'); if (btn) navigate('withdrawals', btn); } }
        });
      } catch (_) {}
    });

    src.addEventListener('investor_registered', e => {
      try {
        const d = JSON.parse(e.data);
        Toast.info(`New investor: ${d.investor_name || 'Investor'} registered`, 6000);
      } catch (_) {}
    });

    src.onerror = () => { src.close(); delay = Math.min(delay * 2, 30000); setTimeout(connect, delay); };
    src.onopen  = () => { delay = 3000; };
  }

  connect();
}
