/* ═══════════════════════════════════════════════
   SV CAPITAL — Shared API Layer
   Backend: Express + PostgreSQL on Railway
   ═══════════════════════════════════════════════ */

'use strict';

/* ─── Platform tag for analytics/audit (ios | android | web) ───
   Sent as the X-Platform header so the server can record which platform
   each request came from (powers admin "Mobile App Activity"). */
function _svcPlatform() {
  try {
    if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function') {
      return window.Capacitor.getPlatform();   // 'ios' | 'android' | 'web'
    }
  } catch (_) {}
  return 'web';
}

/* ─── Session-expired overlay (native app only) ─── */
function _showSessionExpiredOverlay() {
  // Hide loading cover immediately — must happen before anything else so
  // the white cover isn't blocking the overlay.
  if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
  if (document.getElementById('_svcSessionExpired')) return;
  const el = document.createElement('div');
  el.id = '_svcSessionExpired';
  el.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;padding:32px;box-sizing:border-box';
  el.innerHTML = `
    <div style="background:#303030;border-radius:20px;padding:32px 24px;text-align:center;max-width:320px;width:100%">
      <div style="font-size:2.5rem;margin-bottom:16px">🔒</div>
      <div style="color:#fff;font-weight:800;font-size:1.1rem;margin-bottom:8px">Session Expired</div>
      <div style="color:#9ca3af;font-size:0.85rem;line-height:1.6;margin-bottom:24px">Your session has expired. Please log in again to continue.</div>
      <button id="_svcSessionExpiredBtn" style="background:#ff9b0c;color:#000;border:none;border-radius:12px;padding:14px 32px;font-weight:800;font-size:0.95rem;cursor:pointer;width:100%">Log In Again</button>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('_svcSessionExpiredBtn').addEventListener('click', function () {
    try { Auth.logout('/login.html'); } catch (_) { window.location.href = '/login.html'; }
  });
}

/* ─── API Base URL ─── */
// In Capacitor native context, window.__SVC_API_BASE__ is injected by mobile/scripts/build.js
// Otherwise fall back to the relative /api/ path (web / PWA)
const _API_BASE = (typeof window !== 'undefined' && window.__SVC_API_BASE__) || '/api/';

/* ─── Auth token management ─── */
const Auth = {
  /**
   * Get stored JWT token (from localStorage or sessionStorage).
   * Returns null if expired.
   */
  getToken() {
    const token = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token') || null;
    if (!token) return null;
    // Validate expiry without a library
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        // Expired — clean up silently
        localStorage.removeItem('svc_token'); sessionStorage.removeItem('svc_token');
        localStorage.removeItem('svc_user');  sessionStorage.removeItem('svc_user');
        return null;
      }
    } catch (_) {
      localStorage.removeItem('svc_token'); sessionStorage.removeItem('svc_token');
      localStorage.removeItem('svc_user');  sessionStorage.removeItem('svc_user');
      return null;
    }
    return token;
  },

  /**
   * Store token and user info
   */
  setToken(token, user, remember = true) {
    const store = remember ? localStorage : sessionStorage;
    store.setItem('svc_token', token);
    if (user) store.setItem('svc_user', JSON.stringify(user));
  },

  /**
   * Get stored user info.
   * Falls back to the staffSession SSO bridge written by StaffAuth.setSession()
   * so that pages using Auth.getUser() work after a team/PIN login.
   */
  getUser() {
    try {
      // Prefer explicit svc_user (set by JWT login or by StaffAuth SSO bridge)
      const raw = localStorage.getItem('svc_user') || sessionStorage.getItem('svc_user');
      if (raw) return JSON.parse(raw);
    } catch (_) {}

    // Last resort: read staffSession directly
    try {
      const ss = localStorage.getItem('staffSession');
      if (ss) {
        const s = JSON.parse(ss);
        if (s && s.empId && s.expiresAt > Date.now()) {
          return {
            id:        s.empId,
            email:     s.email,
            role:      s.jwtRole || 'staff',
            firstName: s.firstName,
            lastName:  s.lastName,
            _staffSso: true,
          };
        }
      }
    } catch (_) {}
    return null;
  },

  /**
   * Clear auth data (both JWT and StaffAuth SSO bridge).
   * Calling Auth.clear() logs out from both auth systems.
   */
  clear() {
    ['svc_token', 'svc_user', 'svc_portal_cache'].forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });
    // Also clear staffSession so StaffAuth pages redirect to login
    localStorage.removeItem('staffSession');
  },

  /**
   * Sign out of all devices by revoking all server sessions.
   */
  async signOutAll() {
    try { await API._fetch('POST', 'auth/signout-all'); } catch (_) {}
    this.clear();
    window.location.href = '/login.html';
  },

  /**
   * Check if user is authenticated via JWT or staffSession
   */
  isLoggedIn() {
    if (this.getToken()) return true;
    // Fall back to staffSession
    try {
      const ss = localStorage.getItem('staffSession');
      if (ss) {
        const s = JSON.parse(ss);
        return !!(s && s.empId && s.expiresAt > Date.now());
      }
    } catch (_) {}
    return false;
  },

  /**
   * Get role of current user
   */
  getRole() {
    const user = this.getUser();
    return user ? user.role : null;
  },

  /**
   * Redirect to login if not authenticated
   * @param {string} loginPage - relative path to login
   */
  requireLogin(loginPage = '/login.html') {
    if (!this.isLoggedIn()) {
      window.location.href = loginPage;
      return false;
    }
    return true;
  },

  /**
   * Login via API
   */
  async login(email, password, remember = true) {
    const res = await fetch(`${_API_BASE}auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform': _svcPlatform() },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    Auth.setToken(data.token, data.user, remember);
    if (typeof window !== 'undefined' && window.SVC) SVC.track('login', { method: 'password' });
    return data;
  },

  /**
   * Register via API
   */
  async register(payload) {
    const res = await fetch(`${_API_BASE}auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Platform': _svcPlatform() },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    Auth.setToken(data.token, data.user, true);
    if (typeof window !== 'undefined' && window.SVC) SVC.track('sign_up', { method: 'password', has_referral: !!(payload && payload.referredBy) });
    return data;
  },

  /**
   * Logout — clears JWT session, StaffAuth session, and SSO bridge.
   * Works regardless of which login path was used.
   */
  async logout(redirectTo = '/login.html') {
    if (typeof window !== 'undefined' && window.SVC) SVC.track('svc_logout', {});
    // Stop background polling so no further API calls fire after logout
    if (typeof window !== 'undefined' && window._stopPolling) window._stopPolling();
    try {
      await fetch(`${_API_BASE}auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (_) {}
    Auth.clear(); // clears svc_token, svc_user, staffSession
    // Also call StaffAuth.clearSession() if the library is loaded on this page
    if (typeof StaffAuth !== 'undefined' && typeof StaffAuth.clearSession === 'function') {
      StaffAuth.clearSession();
    }
    window.location.href = redirectTo;
  },

  /**
   * Get current user from API (/me)
   */
  async me() {
    const res = await API._fetch('GET', 'auth/me');
    return res;
  },

  /**
   * Change password
   */
  async changePassword(currentPassword, newPassword) {
    return API._fetch('PUT', 'auth/change-password', { currentPassword, newPassword });
  },
};

/* ─── Core fetch helper ─── */
const API = {
  async _fetch(method, path, body = null, params = {}) {
    const qs = Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';
    const url = `${_API_BASE}${path}${qs}`;
    const token = Auth.getToken();

    const opts = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Platform': _svcPlatform(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    // 12-second timeout — prevents hangs when Railway server is cold-starting
    const controller = new AbortController();
    const tId = setTimeout(() => controller.abort(), 12000);
    let r;
    try {
      r = await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(tId);
    }

    // Handle 401 — try silent token refresh before giving up
    if (r.status === 401) {
      try {
        const refreshRes = await fetch(`${_API_BASE}auth/refresh`, { method: 'POST', credentials: 'include' });
        if (refreshRes.ok) {
          const { token } = await refreshRes.json();
          if (token) { Auth.setToken(token); }
          // Retry the original request once with new token
          const retryOpts = { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } };
          const retry = await fetch(url, retryOpts);
          if (retry.ok) { if (retry.status === 204) return true; return retry.json(); }
        }
      } catch (_) {}
      Auth.clear();
      if (window.__SVC_NATIVE__) {
        // Native app: show a dismissible overlay so the user sees a clear message
        // instead of a jarring white screen during a mid-load redirect.
        _showSessionExpiredOverlay();
      } else if (!window.location.pathname.includes('login')) {
        window.location.href = '/login.html';
      }
      throw new Error('Session expired — please log in again.');
    }

    if (!r.ok) {
      let errMsg = `${method} ${path} failed: ${r.status}`;
      try {
        const err = await r.json();
        errMsg = err.error || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    // 204 No Content
    if (r.status === 204) return true;
    return r.json();
  },

  /* ─── Table CRUD ─── */
  async get(table, params = {}) {
    return this._fetch('GET', `tables/${table}`, null, params);
  },

  async getById(table, id) {
    return this._fetch('GET', `tables/${table}/${id}`);
  },

  async post(table, data) {
    return this._fetch('POST', `tables/${table}`, data);
  },

  async put(table, id, data) {
    return this._fetch('PUT', `tables/${table}/${id}`, data);
  },

  async patch(table, id, data) {
    return this._fetch('PATCH', `tables/${table}/${id}`, data);
  },

  async delete(table, id) {
    return this._fetch('DELETE', `tables/${table}/${id}`);
  },

  /* ─── Paginated list ─── */
  async list(table, { page = 1, limit = 100, search = '', sort = '', ...extra } = {}) {
    const params = { page, limit };
    if (search) params.search = search;
    if (sort)   params.sort   = sort;
    Object.assign(params, extra);
    return this.get(table, params);
  },

  /* ─── Domain helpers ─── */
  investors: {
    list:   (opts)     => API.list('investors', opts || {}),
    get:    (id)       => API.getById('investors', id),
    create: (data)     => API.post('investors', data),
    update: (id, data) => API.patch('investors', id, data),
    delete: (id)       => API.delete('investors', id),
  },
  pools: {
    list:   (opts)     => API.list('investment_pools', opts || {}),
    get:    (id)       => API.getById('investment_pools', id),
    create: (data)     => API.post('investment_pools', data),
    update: (id, data) => API.patch('investment_pools', id, data),
    delete: (id)       => API.delete('investment_pools', id),
  },
  investments: {
    list:   (opts)     => API.list('investments', opts || {}),
    get:    (id)       => API.getById('investments', id),
    create: (data)     => API.post('investments', data),
    update: (id, data) => API.patch('investments', id, data),
  },
  products: {
    list:   (opts)     => API.list('products', opts || {}),
    get:    (id)       => API.getById('products', id),
    create: (data)     => API.post('products', data),
    update: (id, data) => API.patch('products', id, data),
    delete: (id)       => API.delete('products', id),
  },
  transactions: {
    list:   (opts)     => API.list('transactions', opts || {}),
    get:    (id)       => API.getById('transactions', id),
    create: (data)     => API.post('transactions', data),
    update: (id, data) => API.patch('transactions', id, data),
  },
  kyc: {
    list:   (opts)     => API.list('kyc_documents', opts || {}),
    get:    (id)       => API.getById('kyc_documents', id),
    update: (id, data) => API.patch('kyc_documents', id, data),
    create: (data)     => API.post('kyc_documents', data),
  },
  tickets: {
    list:   (opts)     => API.list('support_tickets', opts || {}),
    get:    (id)       => API.getById('support_tickets', id),
    create: (data)     => API.post('support_tickets', data),
    update: (id, data) => API.patch('support_tickets', id, data),
  },
  maturityInstructions: {
    list:   (opts)     => API.list('maturity_instructions', opts || {}),
    get:    (id)       => API.getById('maturity_instructions', id),
    create: (data)     => API.post('maturity_instructions', data),
    update: (id, data) => API.patch('maturity_instructions', id, data),
  },
  settings: {
    list:   ()         => API.list('platform_settings'),
    update: (id, data) => API.patch('platform_settings', id, data),
  },
  ifas: {
    list:   (opts)     => API.list('ifas', opts || {}),
    get:    (id)       => API.getById('ifas', id),
    create: (data)     => API.post('ifas', data),
    update: (id, data) => API.patch('ifas', id, data),
    delete: (id)       => API.delete('ifas', id),
  },
  fundRuns: {
    list:   (opts)     => API.list('fund_runs', opts || {}),
    get:    (id)       => API.getById('fund_runs', id),
    create: (data)     => API.post('fund_runs', data),
    update: (id, data) => API.patch('fund_runs', id, data),
    delete: (id)       => API.delete('fund_runs', id),
  },
  returnSchedules: {
    list:   (opts)     => API.list('return_schedules', opts || {}),
    get:    (id)       => API.getById('return_schedules', id),
    create: (data)     => API.post('return_schedules', data),
    update: (id, data) => API.patch('return_schedules', id, data),
  },
  employees: {
    list:   (opts)     => API.list('employees', opts || {}),
    get:    (id)       => API.getById('employees', id),
    create: (data)     => API.post('employees', data),
    update: (id, data) => API.patch('employees', id, data),
    delete: (id)       => API.delete('employees', id),
  },
  users: {
    list:        (opts)           => API._fetch('GET', 'users', null, opts || {}),
    get:         (id)             => API._fetch('GET', `users/${id}`),
    create:      (data)           => API._fetch('POST', 'users', data),
    update:      (id, data)       => API._fetch('PUT', `users/${id}`, data),
    delete:      (id)             => API._fetch('DELETE', `users/${id}`),
    toggleActive:(id)             => API._fetch('PATCH', `users/${id}/toggle-active`),
    resetPassword:(id, newPassword) => API._fetch('PATCH', `users/${id}/reset-password`, { newPassword }),
  },
};

/* ═══════════════════════════════════════════════
   UTILITY FUNCTIONS (shared across all pages)
   ═══════════════════════════════════════════════ */

const Utils = {
  /* Format South African Rand */
  rand(amount, decimals = 0) {
    if (amount == null || isNaN(amount)) return 'R0';
    return 'R' + Number(amount).toLocaleString('en-ZA', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  },

  /* Format percentage */
  pct(rate, decimals = 2) {
    return (Number(rate) * 100).toFixed(decimals) + '%';
  },

  /* Format date */
  date(str) {
    if (!str) return '—';
    return new Date(str).toLocaleDateString('en-ZA', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  },

  /* Format datetime */
  datetime(str) {
    if (!str) return '—';
    return new Date(str).toLocaleString('en-ZA', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  },

  /* Relative time */
  timeAgo(str) {
    if (!str) return '—';
    const diff = Date.now() - new Date(str).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return Utils.date(str);
  },

  /* Initials from name */
  initials(name) {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  },

  /* Product display info */
  productInfo(type) {
    const map = {
      cattle:         { label: 'Cattle Investment',       icon: 'fa-cow',        color: '#D4AF37', badgeClass: 'badge--gold' },
      solar:          { label: 'Solar Investment',        icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      solar_7yr:      { label: 'Solar Investment (7yr)',  icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      solar_6yr:      { label: 'Solar Investment (6yr)',  icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      solar_5yr:      { label: 'Solar Investment (5yr)',  icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      short_term:     { label: 'Short Term Investment',   icon: 'fa-bolt',        color: '#656565', badgeClass: 'badge--blue' },
      smme:           { label: 'Short Term Investment',   icon: 'fa-bolt',        color: '#656565', badgeClass: 'badge--blue' },
      delivery_bikes: { label: 'Delivery Bikes',          icon: 'fa-motorcycle',  color: '#f97316', badgeClass: 'badge--orange' },
      delivery_bike:  { label: 'Delivery Bikes',          icon: 'fa-motorcycle',  color: '#f97316', badgeClass: 'badge--orange' },
      other:          { label: 'Other',                   icon: 'fa-circle',      color: '#656565', badgeClass: 'badge--gray' },
    };
    return map[type] || { label: type, icon: 'fa-circle', color: '#656565', badgeClass: 'badge--gray' };
  },

  /* Status badge HTML */
  statusBadge(status) {
    const map = {
      active:           ['badge--green',  'Active'],
      open:             ['badge--green',  'Open'],
      filling:          ['badge--blue',   'Filling'],
      approved:         ['badge--green',  'Approved'],
      completed:        ['badge--green',  'Completed'],
      paid_out:         ['badge--purple', 'Matured'],   // merged into Matured
      matured:          ['badge--purple', 'Matured'],
      pending:          ['badge--orange', 'Pending'],
      pending_fica:     ['badge--orange', 'Pending FICA'],
      fica_submitted:   ['badge--blue',   'FICA Submitted'],
      submitted:        ['badge--blue',   'Submitted'],
      under_review:     ['badge--blue',   'Under Review'],
      processing:       ['badge--blue',   'Processing'],
      in_progress:      ['badge--blue',   'In Progress'],
      waiting_investor: ['badge--orange', 'Waiting'],
      suspended:        ['badge--red',    'Suspended'],
      rejected:         ['badge--red',    'Rejected'],
      failed:           ['badge--red',    'Failed'],
      closed:           ['badge--gray',   'Closed'],
      reinvested:       ['badge--purple', 'Reinvested'],
      fica_approved:    ['badge--green',  'FICA Approved'],
      resolved:         ['badge--gray',   'Resolved'],
      draft:            ['badge--gray',   'Draft'],
      cancelled:        ['badge--red',    'Cancelled'],
      verified:         ['badge--green',  'Verified'],
      expired:          ['badge--orange', 'Expired'],
      onboarding:       ['badge--blue',   'Onboarding'],
      inactive:         ['badge--gray',   'Inactive'],
      paid:             ['badge--green',  'Paid'],
      overdue:          ['badge--red',    'Overdue'],
      accrued:          ['badge--blue',   'Accrued'],
      collected:        ['badge--green',  'Collected'],
      waived:           ['badge--gray',   'Waived'],
    };
    const [cls, label] = map[status] || ['badge--gray', status];
    return `<span class="badge ${cls}">${label}</span>`;
  },

  /* Priority badge */
  priorityBadge(priority) {
    const map = {
      low:    'badge--gray',
      medium: 'badge--blue',
      high:   'badge--orange',
      urgent: 'badge--red',
    };
    return `<span class="badge ${map[priority] || 'badge--gray'}">${priority}</span>`;
  },

  /* Generate ID */
  genId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  },

  /* Debounce */
  debounce(fn, ms = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  /* Pool fill percentage — prefer live_raised from server aggregation */
  poolFillPct(pool) {
    if (!pool.target_amount) return 0;
    const raised = pool.live_raised ?? pool.raised_amount ?? 0;
    return Math.min(100, Math.round((raised / pool.target_amount) * 100));
  },

  /* Days remaining */
  daysRemaining(dateStr) {
    if (!dateStr) return null;
    const diff = new Date(dateStr) - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
  },

  /* Is this pool targeting a closing DATE rather than a goal AMOUNT? */
  poolIsDateTarget(pool) {
    return (pool && pool.target_type) === 'date';
  },

  /* Date-target fill — fraction of the open→close window that has elapsed (0–100). */
  poolDateProgressPct(pool) {
    const end   = pool && pool.end_date ? new Date(pool.end_date).getTime() : null;
    if (!end) return 0;
    const now   = Date.now();
    const start = pool.start_date ? new Date(pool.start_date).getTime() : null;
    if (!start || start >= end) return now >= end ? 100 : 0;
    if (now <= start) return 0;
    if (now >= end)   return 100;
    return Math.min(100, Math.max(0, Math.round((now - start) / (end - start) * 100)));
  }
};

/* ═══════════════════════════════════════════════
   TOAST SYSTEM
   ═══════════════════════════════════════════════ */
const Toast = {
  container: null,
  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },
  show(message, type = 'info', duration = 4000) {
    if (!this.container) this.init();
    // Cap at 4 visible toasts — remove oldest when exceeded
    const existing = this.container.querySelectorAll('.toast');
    if (existing.length >= 4) existing[0].remove();
    const icons = { success: 'fa-check-circle', error: 'fa-circle-xmark', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${icons[type] || icons.info}`;
    const msg = document.createElement('span');
    msg.className = 'toast__msg';
    msg.textContent = message;
    const dismiss = document.createElement('button');
    dismiss.setAttribute('style', 'background:none;border:none;cursor:pointer;color:inherit;opacity:0.5;margin-left:4px;padding:0 2px;font-size:0.9rem;line-height:1');
    dismiss.title = 'Dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => toast.remove());
    toast.append(icon, msg, dismiss);
    this.container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'none';
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = '0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  success: (msg) => Toast.show(msg, 'success'),
  error:   (msg) => Toast.show(msg, 'error'),
  info:    (msg) => Toast.show(msg, 'info'),
  warning: (msg) => Toast.show(msg, 'warning'),
};

/* ═══════════════════════════════════════════════
   MODAL SYSTEM
   ═══════════════════════════════════════════════ */
const Modal = {
  _prevFocus: null,
  _trapHandler: null,
  open(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    Modal._prevFocus = document.activeElement;
    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable[0]) focusable[0].focus();
    // Focus trap
    Modal._trapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    el.addEventListener('keydown', Modal._trapHandler);
  },
  close(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    document.body.style.overflow = '';
    el.removeAttribute('role');
    el.removeAttribute('aria-modal');
    if (Modal._trapHandler) { el.removeEventListener('keydown', Modal._trapHandler); Modal._trapHandler = null; }
    if (Modal._prevFocus) { Modal._prevFocus.focus(); Modal._prevFocus = null; }
  },
  closeAll() {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.classList.remove('open');
    });
    document.body.style.overflow = '';
  }
};

/* ─── Global ESC to close modals ─── */
document.addEventListener('keydown', e => { if (e.key === 'Escape') Modal.closeAll(); });
