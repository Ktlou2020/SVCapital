/* ═══════════════════════════════════════════════
   SV CAPITAL — Shared API Layer
   Wraps the RESTful Table API with typed helpers
   ═══════════════════════════════════════════════ */

'use strict';

/* ─── Base URL: resolve from root to work from any subdirectory ─── */
const _API_BASE = (() => {
  // Count path segments from the current page to compute relative depth.
  // pathname example from root: /api/code_sandbox_light/preview/{id}/admin/index.html
  // We need to strip the filename and go up enough levels to reach tables/
  const path = window.location.pathname;
  // Count directory segments in path (after the trailing slash)
  const parts = path.replace(/\/[^/]+$/, '').split('/').filter(Boolean);
  // The "tables" endpoint lives at the project root level.
  // Detect nesting: if we're in admin/ or portal/, we need one "../"
  // Simple heuristic: count path segments that look like subdirectories
  const segments = path.split('/').filter(Boolean);
  // Last segment is the file, everything else is directories
  const dirs = segments.length - 1; // number of directory segments
  // The tables/ API is always at the project base.
  // In the sandbox, project base = preview/{id}/ which has some prefix.
  // We use a relative approach: go up enough to reach project root.
  // Typical structure: /prefix/admin/ needs '../', /prefix/ needs ''
  // Detect if we're in a subdirectory of the project by looking at path depth vs known base.
  // Simpler: we always use '../' for known subdirs (admin, portal) and '' for root.
  const isSubdir = /\/(admin|portal|ifa|fund)\//.test(path);
  return isSubdir ? '../' : '';
})();

const API = {
  /* ─── Core Fetch ─── */
  async get(table, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${_API_BASE}tables/${table}${qs ? '?' + qs : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`GET ${table} failed: ${r.status}`);
    return r.json();
  },

  async getById(table, id) {
    const r = await fetch(`${_API_BASE}tables/${table}/${id}`);
    if (!r.ok) throw new Error(`GET ${table}/${id} failed: ${r.status}`);
    return r.json();
  },

  async post(table, data) {
    const r = await fetch(`${_API_BASE}tables/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`POST ${table} failed: ${r.status}`);
    return r.json();
  },

  async put(table, id, data) {
    const r = await fetch(`${_API_BASE}tables/${table}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`PUT ${table}/${id} failed: ${r.status}`);
    return r.json();
  },

  async patch(table, id, data) {
    const r = await fetch(`${_API_BASE}tables/${table}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`PATCH ${table}/${id} failed: ${r.status}`);
    return r.json();
  },

  async delete(table, id) {
    const r = await fetch(`${_API_BASE}tables/${table}/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`DELETE ${table}/${id} failed: ${r.status}`);
    return true;
  },

  /* ─── Paginated list ─── */
  async list(table, { page = 1, limit = 100, search = '', sort = '' } = {}) {
    return this.get(table, { page, limit, ...(search && { search }), ...(sort && { sort }) });
  },

  /* ─── Domain helpers ─── */
  investors: {
    list: (opts) => API.list('investors', opts),
    get: (id) => API.getById('investors', id),
    create: (data) => API.post('investors', data),
    update: (id, data) => API.patch('investors', id, data),
    delete: (id) => API.delete('investors', id),
  },
  pools: {
    list: (opts) => API.list('investment_pools', opts),
    get: (id) => API.getById('investment_pools', id),
    create: (data) => API.post('investment_pools', data),
    update: (id, data) => API.patch('investment_pools', id, data),
  },
  investments: {
    list: (opts) => API.list('investments', opts),
    get: (id) => API.getById('investments', id),
    create: (data) => API.post('investments', data),
    update: (id, data) => API.patch('investments', id, data),
  },
  transactions: {
    list: (opts) => API.list('transactions', opts),
    get: (id) => API.getById('transactions', id),
    create: (data) => API.post('transactions', data),
    update: (id, data) => API.patch('transactions', id, data),
  },
  kyc: {
    list: (opts) => API.list('kyc_documents', opts),
    get: (id) => API.getById('kyc_documents', id),
    update: (id, data) => API.patch('kyc_documents', id, data),
    create: (data) => API.post('kyc_documents', data),
  },
  tickets: {
    list: (opts) => API.list('support_tickets', opts),
    get: (id) => API.getById('support_tickets', id),
    create: (data) => API.post('support_tickets', data),
    update: (id, data) => API.patch('support_tickets', id, data),
  },
  maturityInstructions: {
    list: (opts) => API.list('maturity_instructions', opts),
    get: (id) => API.getById('maturity_instructions', id),
    create: (data) => API.post('maturity_instructions', data),
    update: (id, data) => API.patch('maturity_instructions', id, data),
  },
  settings: {
    list: () => API.list('platform_settings'),
    update: (id, data) => API.patch('platform_settings', id, data),
  }
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
      cattle: { label: 'Cattle', icon: 'fa-cow', color: '#D4AF37', badgeClass: 'badge--gold' },
      solar_7yr: { label: 'Solar 7yr', icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      solar_6yr: { label: 'Solar 6yr', icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      solar_5yr: { label: 'Solar 5yr', icon: 'fa-solar-panel', color: '#22c55e', badgeClass: 'badge--green' },
      short_term: { label: 'Short-Term', icon: 'fa-bolt', color: '#3b82f6', badgeClass: 'badge--blue' },
      delivery_bike: { label: 'Delivery Bike', icon: 'fa-motorcycle', color: '#f97316', badgeClass: 'badge--orange' },
    };
    return map[type] || { label: type, icon: 'fa-circle', color: '#8ea3b8', badgeClass: 'badge--gray' };
  },

  /* Status badge HTML */
  statusBadge(status) {
    const map = {
      active: ['badge--green', 'Active'],
      open: ['badge--green', 'Open'],
      filling: ['badge--blue', 'Filling'],
      approved: ['badge--green', 'Approved'],
      completed: ['badge--green', 'Completed'],
      paid_out: ['badge--green', 'Paid Out'],
      matured: ['badge--purple', 'Matured'],
      pending: ['badge--orange', 'Pending'],
      pending_fica: ['badge--orange', 'Pending FICA'],
      fica_submitted: ['badge--blue', 'FICA Submitted'],
      submitted: ['badge--blue', 'Submitted'],
      under_review: ['badge--blue', 'Under Review'],
      processing: ['badge--blue', 'Processing'],
      in_progress: ['badge--blue', 'In Progress'],
      waiting_investor: ['badge--orange', 'Waiting'],
      suspended: ['badge--red', 'Suspended'],
      rejected: ['badge--red', 'Rejected'],
      failed: ['badge--red', 'Failed'],
      closed: ['badge--gray', 'Closed'],
      reinvested: ['badge--purple', 'Reinvested'],
      fica_approved: ['badge--green', 'FICA Approved'],
      resolved: ['badge--gray', 'Resolved'],
    };
    const [cls, label] = map[status] || ['badge--gray', status];
    return `<span class="badge ${cls}">${label}</span>`;
  },

  /* Priority badge */
  priorityBadge(priority) {
    const map = {
      low: 'badge--gray',
      medium: 'badge--blue',
      high: 'badge--orange',
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

  /* Pool fill percentage */
  poolFillPct(pool) {
    if (!pool.target_amount) return 0;
    return Math.min(100, Math.round((pool.raised_amount / pool.target_amount) * 100));
  },

  /* Days remaining */
  daysRemaining(dateStr) {
    if (!dateStr) return null;
    const diff = new Date(dateStr) - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
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
    const icons = { success: 'fa-check-circle', error: 'fa-circle-xmark', info: 'fa-circle-info', warning: 'fa-triangle-exclamation' };
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span class="toast__msg">${message}</span>`;
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
  error: (msg) => Toast.show(msg, 'error'),
  info: (msg) => Toast.show(msg, 'info'),
};

/* ═══════════════════════════════════════════════
   MODAL SYSTEM
   ═══════════════════════════════════════════════ */
const Modal = {
  open(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
  },
  close(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
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
