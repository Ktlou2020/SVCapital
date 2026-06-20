/**
 * SV Capital — Staff Authentication & RBAC
 * =========================================
 * Shared module included in every staff-facing page.
 *
 * Storage key : localStorage['staffSession']
 * Session shape:
 * {
 *   empId       : string   (UUID from employees table)
 *   email       : string
 *   firstName   : string
 *   lastName    : string
 *   role        : string   (e.g. "CEO", "Investment Analyst" …)
 *   level       : string   (junior | mid | senior | lead | executive)
 *   department  : string
 *   avatarInitials : string
 *   avatarColor    : string
 *   xpPoints    : number
 *   loginTime   : number   (Date.now())
 *   expiresAt   : number   (loginTime + SESSION_TTL)
 * }
 */

;(function(global) {
  'use strict';

  /* ─── Constants ─────────────────────────────────────────────── */
  const SESSION_KEY  = 'staffSession';
  const SESSION_TTL  = 8 * 60 * 60 * 1000;   // 8 hours in ms

  /* Derive login/hub URLs relative to current script location so this
     works in preview environments as well as production. */
  function _resolveStaffUrl(filename) {
    // Try to find the base by locating this script tag's src
    const scripts = document.querySelectorAll('script[src*="staff-auth"]');
    if (scripts.length > 0) {
      const src = scripts[0].getAttribute('src');
      // src is like "../js/staff-auth.js" or "/js/staff-auth.js"
      // We need the team/ directory which is one level up from js/
      const base = src.replace(/js\/staff-auth\.js.*$/, '');
      return base + 'team/' + filename;
    }
    return '/team/' + filename;
  }

  const LOGIN_URL = () => _resolveStaffUrl('login.html');
  const HUB_URL   = () => _resolveStaffUrl('hub.html');

  /* ─── RBAC Matrix ────────────────────────────────────────────
   * Maps every role to the list of app-keys it may access.
   * App keys map to physical paths in APPS_REGISTRY (below).
   * Overridden at runtime by loadRbac() from /api/settings/rbac.
   */
  let _rbacCache = null;

  const ROLE_PERMISSIONS = {
    'CEO':                  ['employee', 'team', 'fund', 'admin', 'ifa', 'portal', 'director', 'accounting'],
    'Operations Manager':   ['employee', 'team', 'fund', 'admin', 'accounting'],
    'Finance Manager':      ['employee', 'team', 'fund', 'admin', 'accounting'],
    'Tech Lead':            ['employee', 'team', 'fund', 'admin', 'accounting'],
    'Investment Analyst':   ['employee', 'team', 'fund'],
    'Compliance Officer':   ['employee', 'admin'],
    'Client Relations':     ['employee', 'portal'],
    'Marketing':            ['employee'],
    'Junior Analyst':       ['employee'],
    'Admin':                ['employee'],
  };

  /* Level-based elevation (overrides role if level is executive) */
  const EXECUTIVE_APPS = ['employee', 'team', 'fund', 'admin', 'ifa', 'portal', 'director', 'accounting'];

  /* Director-level check — executive level, CEO/COO/CTO/CFO titles,
     or a JWT role of 'director' or 'admin' all grant Director panel access */
  function isDirector(session) {
    if (!session) return false;
    if (session.level === 'executive') return true;
    // JWT-role check (synthetic sessions built from JWT payload)
    if (session.role === 'director' || session.role === 'admin') return true;
    // Role-title check — covers common C-suite variations
    const r = (session.role || '').toLowerCase();
    return r.includes('ceo') || r.includes('coo') || r.includes('cto') ||
           r.includes('cfo') || r.includes('director') || r.includes('chief');
  }

  /* ─── App Registry ───────────────────────────────────────────
   * key        : internal identifier used in ROLE_PERMISSIONS
   * label      : display name on hub tiles
   * description: sub-line on hub tile
   * icon       : Font Awesome class string
   * color      : accent colour for tile
   * path       : URL path (relative to site root)
   * badge      : optional badge text (e.g. "New")
   * guard      : if true, the auth guard will redirect non-matching sessions away
   */
  const APPS_REGISTRY = {
    employee: {
      label:       'My Dashboard',
      description: 'Personal KPIs, EVA payslip, learning & more',
      icon:        'fa-solid fa-user-circle',
      color:       '#7c5cfc',
      path:        '/team/employee.html',
      guard:       true,
    },
    team: {
      label:       'Team Dashboard',
      description: 'EVA engine, team KPIs & headcount overview',
      icon:        'fa-solid fa-people-group',
      color:       '#00d4aa',
      path:        '/team/index.html',
      guard:       true,
    },
    fund: {
      label:       'Fund Operations',
      description: 'AUM tracking, returns & fund management',
      icon:        'fa-solid fa-chart-line',
      color:       '#f59e0b',
      path:        '/fund/index.html',
      guard:       true,
    },
    admin: {
      label:       'Admin Console',
      description: 'Platform administration & investor management',
      icon:        'fa-solid fa-shield-halved',
      color:       '#e84393',
      path:        '/admin/index.html',
      guard:       true,
    },
    ifa: {
      label:       'IFA Portal',
      description: 'Independent Financial Adviser tools & reporting',
      icon:        'fa-solid fa-handshake',
      color:       '#06b6d4',
      path:        '/ifa/index.html',
      guard:       true,
    },
    portal: {
      label:       'Investor Portal',
      description: 'Investor accounts, documents & performance',
      icon:        'fa-solid fa-building-columns',
      color:       '#10b981',
      path:        '/portal/index.html',
      guard:       true,
    },
  };

  /* ─────────────────────────────────────────────────────────────
   * Session helpers
   * ───────────────────────────────────────────────────────────── */

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !s.empId || !s.expiresAt) return null;
      if (Date.now() > s.expiresAt) { clearSession(); return null; }
      return s;
    } catch(e) { return null; }
  }

  function setSession(employee) {
    const now = Date.now();
    const session = {
      empId:          employee.id,
      email:          employee.email,
      firstName:      employee.first_name,
      lastName:       employee.last_name,
      role:           employee.role,
      level:          employee.level,
      department:     employee.department || '',
      avatarInitials: employee.avatar_initials || (employee.first_name[0] + employee.last_name[0]).toUpperCase(),
      avatarColor:    employee.avatar_color || '#7c5cfc',
      xpPoints:       Number(employee.xp_points) || 0,
      loginTime:      now,
      expiresAt:      now + SESSION_TTL,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));

    // ── SSO bridge: write a compatible svc_user record so that api.js Auth
    //    helpers (Auth.isLoggedIn, Auth.getUser, Auth.getRole) see this session.
    //    Maps employee role titles to JWT roles used by admin/ifa pages.
    const jwtRole = _empRoleToJwtRole(employee.role, employee.level);
    const bridge = {
      id:        employee.id,
      email:     employee.email,
      role:      jwtRole,
      firstName: employee.first_name,
      lastName:  employee.last_name,
      _staffSso: true,   // marker so Auth.clear() knows it can remove this
    };
    localStorage.setItem('svc_user', JSON.stringify(bridge));

    return session;
  }

  /* Map employee role/level strings → JWT role used by admin.js guards */
  function _empRoleToJwtRole(role, level) {
    if (level === 'executive') return 'director';
    if (!role) return 'staff';
    const r = role.toLowerCase();
    if (r.includes('ceo') || r.includes('director') || r.includes('coo') || r.includes('cto')) return 'director';
    if (r.includes('admin') || r.includes('compliance') || r.includes('finance') || r.includes('operations') || r.includes('tech lead')) return 'admin';
    if (r.includes('ifa') || r.includes('adviser') || r.includes('advisor')) return 'ifa';
    return 'staff';
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    // Also clear the SSO bridge user record if it was written by staff login
    try {
      const raw = localStorage.getItem('svc_user');
      if (raw) {
        const u = JSON.parse(raw);
        if (u && u._staffSso) localStorage.removeItem('svc_user');
      }
    } catch (_) {}
  }

  function refreshSession(updates) {
    const s = getSession();
    if (!s) return;
    Object.assign(s, updates);
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  /* ─────────────────────────────────────────────────────────────
   * RBAC helpers
   * ───────────────────────────────────────────────────────────── */

  async function loadRbac() {
    try {
      const base = window.__SVC_API_BASE__ || '/api/';
      const r = await fetch(base + 'settings/rbac');
      if (!r.ok) return null;
      const data = await r.json();
      if (data && data.matrix && typeof data.matrix === 'object' && !Array.isArray(data.matrix)) {
        _rbacCache = data.matrix;
      }
    } catch (_) {}
    return _rbacCache;
  }

  function getAllowedApps(session) {
    if (!session) return [];
    // Executive level gets everything regardless of role title
    if (session.level === 'executive') return EXECUTIVE_APPS.slice();
    const matrix = _rbacCache || ROLE_PERMISSIONS;
    const perms = matrix[session.role] || ['employee'];
    return perms.slice();
  }

  function canAccess(session, appKey) {
    return getAllowedApps(session).includes(appKey);
  }

  /* Determine which appKey the current page corresponds to */
  function currentAppKey() {
    const path = window.location.pathname;
    if (path.includes('/team/employee'))  return 'employee';
    if (path.includes('/team/index') || path.endsWith('/team/')) return 'team';
    if (path.includes('/fund/'))          return 'fund';
    if (path.includes('/admin/'))         return 'admin';
    if (path.includes('/ifa/'))           return 'ifa';
    if (path.includes('/portal/'))        return 'portal';
    if (path.includes('/team/accounting')) return 'accounting';
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
   * Auth Guard
   * Call StaffAuth.guard() at the top of any staff page.
   * If no valid session exists → redirect to login.
   * If session exists but role not permitted → redirect to hub.
   * ───────────────────────────────────────────────────────────── */

  function guard(requiredAppKey) {
    const session = getSession();

    // ── JWT bypass: if a valid svc_token JWT exists, allow access ──
    // This lets users logged in via /login.html (JWT auth) access staff pages
    // without needing a separate staffSession.
    if (!session) {
      try {
        const jwt = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
        if (jwt) {
          const payload = JSON.parse(atob(jwt.split('.')[1]));
          if (payload && payload.exp * 1000 > Date.now()) {
            // Valid JWT present — allow access, skip staffSession check
            return true;
          }
        }
      } catch (_) {}

      // No valid session or JWT — redirect to login
      sessionStorage.setItem('staffLoginRedirect', window.location.pathname);
      window.location.replace(LOGIN_URL());
      return false;
    }

    const appKey = requiredAppKey || currentAppKey();
    if (appKey && !canAccess(session, appKey)) {
      // Authenticated but not authorised for this app
      window.location.replace(HUB_URL() + '?denied=' + encodeURIComponent(appKey));
      return false;
    }

    return true;
  }

  /* ─────────────────────────────────────────────────────────────
   * Logout
   * ───────────────────────────────────────────────────────────── */

  function logout() {
    clearSession(); // clears staffSession + svc_user SSO bridge

    // Also clear JWT tokens so main login.html doesn't auto-restore the session
    ['svc_token', 'svc_user'].forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });

    // Tell the server to clear the httpOnly cookie
    fetch((window.__SVC_API_BASE__ || '/api/') + 'auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});

    window.location.replace(LOGIN_URL());
  }

  /* ─────────────────────────────────────────────────────────────
   * Inject a compact topbar session widget into any staff page.
   * Adds a floating pill (top-right) showing avatar + name + logout.
   * Usage: StaffAuth.injectWidget()
   * ───────────────────────────────────────────────────────────── */

  function injectWidget() {
    const session = getSession();
    if (!session) return;

    // Don't double-inject
    if (document.getElementById('staffAuthWidget')) return;

    const allowed = getAllowedApps(session);
    const hubUrl  = HUB_URL();

    const widget = document.createElement('div');
    widget.id = 'staffAuthWidget';
    widget.innerHTML = `
      <style>
        /* ── Wrapper: sits bottom-right, never overlaps content ── */
        #staffAuthWidget {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 9000;
          font-family: 'Inter', -apple-system, sans-serif;
          font-size: 0.78rem;
          user-select: none;
        }

        /* ── Avatar trigger button (always visible — small circle) ── */
        #sawTrigger {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: ${session.avatarColor};
          border: 2px solid rgba(255,255,255,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.68rem;
          font-weight: 800;
          color: #fff;
          cursor: pointer;
          box-shadow: 0 2px 10px rgba(0,0,0,0.4);
          transition: transform 0.15s, box-shadow 0.15s;
          margin-left: auto;
        }
        #sawTrigger:hover {
          transform: scale(1.08);
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        }

        /* ── Popup card: hidden by default, appears above the avatar ── */
        #sawPopup {
          position: absolute;
          bottom: 44px;
          right: 0;
          min-width: 200px;
          background: rgba(14,15,22,0.97);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255,255,255,0.09);
          border-radius: 14px;
          padding: 14px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.55);
          color: #c8cce0;
          opacity: 0;
          transform: translateY(6px) scale(0.97);
          pointer-events: none;
          transition: opacity 0.18s ease, transform 0.18s ease;
        }
        #sawPopup.saw-open {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: all;
        }

        /* ── Popup header ── */
        .saw-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding-bottom: 10px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          margin-bottom: 10px;
        }
        .saw-avatar-lg {
          width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
          background: ${session.avatarColor};
          display: flex; align-items: center; justify-content: center;
          font-size: 0.72rem; font-weight: 800; color: #fff;
        }
        .saw-name { font-weight: 700; color: #e8eaf6; font-size: 0.82rem; line-height: 1.2; }
        .saw-role { color: #6b7280; font-size: 0.7rem; margin-top: 1px; }

        /* ── Popup action rows ── */
        .saw-action {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 7px 8px;
          border-radius: 8px;
          cursor: pointer;
          text-decoration: none;
          color: #9ca3af;
          font-size: 0.78rem;
          font-weight: 500;
          transition: background 0.12s, color 0.12s;
          width: 100%;
          background: none;
          border: none;
          font-family: inherit;
          text-align: left;
        }
        .saw-action:hover { background: rgba(255,255,255,0.06); color: #e8eaf6; }
        .saw-action i { width: 16px; text-align: center; font-size: 0.8rem; }
        .saw-action--danger       { color: #f87171; }
        .saw-action--danger:hover { background: rgba(248,113,113,0.08); color: #f87171; }

        /* ── Separator ── */
        .saw-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 6px 0; }
      </style>

      <!-- Avatar trigger -->
      <div id="sawTrigger" title="${session.firstName} ${session.lastName}" onclick="document.getElementById('sawPopup').classList.toggle('saw-open')">
        ${session.avatarInitials}
      </div>

      <!-- Popup card -->
      <div id="sawPopup">
        <div class="saw-header">
          <div class="saw-avatar-lg">${session.avatarInitials}</div>
          <div>
            <div class="saw-name">${session.firstName} ${session.lastName}</div>
            <div class="saw-role">${session.role}</div>
          </div>
        </div>

        ${allowed.length > 1 ? `
        <a class="saw-action" href="${hubUrl}">
          <i class="fa-solid fa-grid-2"></i> App Hub
        </a>` : ''}

        <button class="saw-action saw-action--danger" onclick="StaffAuth.logout()">
          <i class="fa-solid fa-arrow-right-from-bracket"></i> Sign out
        </button>
      </div>
    `;

    document.body.appendChild(widget);

    /* Close popup when clicking anywhere outside */
    document.addEventListener('click', function sawOutside(e) {
      const w = document.getElementById('staffAuthWidget');
      if (w && !w.contains(e.target)) {
        document.getElementById('sawPopup')?.classList.remove('saw-open');
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
   * Public API
   * ───────────────────────────────────────────────────────────── */
  global.StaffAuth = {
    SESSION_KEY,
    APPS_REGISTRY,
    ROLE_PERMISSIONS,
    getSession,
    setSession,
    clearSession,
    refreshSession,
    loadRbac,
    getAllowedApps,
    canAccess,
    currentAppKey,
    isDirector,
    guard,
    logout,
    injectWidget,
  };

})(window);
