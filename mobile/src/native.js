/**
 * SV Capital — Capacitor native bridge
 * Uses window.Capacitor global API (no bundler needed).
 * Loaded only when window.__SVC_NATIVE__ === true.
 */
(function () {
  if (!window.__SVC_NATIVE__ || !window.Capacitor) return;

  const P = window.Capacitor.Plugins;

  /* ── Status bar ─────────────────────────────────── */
  async function initStatusBar() {
    if (!P.StatusBar) return;
    await P.StatusBar.setStyle({ style: 'DARK' });
    // setBackgroundColor is Android-only — ignore on iOS
    await P.StatusBar.setBackgroundColor({ color: '#0f1623' }).catch(() => {});
    await P.StatusBar.setOverlaysWebView({ overlay: false });
  }

  /* ── Splash screen ──────────────────────────────── */
  async function hideSplash() {
    if (!P.SplashScreen) return;
    await P.SplashScreen.hide({ fadeOutDuration: 300 });
  }

  /* ── Network monitoring ─────────────────────────── */
  async function initNetwork() {
    if (!P.Network) return;
    const status = await P.Network.getStatus();
    if (!status.connected) showOfflineBanner();
    P.Network.addListener('networkStatusChange', s => {
      if (!s.connected) showOfflineBanner();
      else hideOfflineBanner();
    });
  }

  function showOfflineBanner() {
    let el = document.getElementById('_nativeOfflineBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = '_nativeOfflineBanner';
      el.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#ef4444', 'color:#fff', 'font-size:13px', 'font-weight:600',
        'text-align:center', 'padding:8px', 'letter-spacing:0.02em',
      ].join(';');
      el.textContent = 'No internet connection';
      document.body.prepend(el);
    }
    el.style.display = 'block';
  }

  function hideOfflineBanner() {
    const el = document.getElementById('_nativeOfflineBanner');
    if (el) el.style.display = 'none';
  }

  /* ── Push Notifications ─────────────────────────── */
  async function initPush() {
    if (!P.PushNotifications) return;
    let perm = await P.PushNotifications.checkPermissions();
    if (perm.receive === 'prompt') {
      perm = await P.PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return;

    await P.PushNotifications.register();

    P.PushNotifications.addListener('registration', async token => {
      try {
        const apiBase = window.__SVC_API_BASE__ || '/api/';
        const authToken = localStorage.getItem('svc_token');
        if (!authToken) return;
        await fetch(`${apiBase}investors/push-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ token: token.value, platform: window.Capacitor.getPlatform() }),
        });
      } catch (_) {}
    });

    P.PushNotifications.addListener('registrationError', err => {
      console.warn('[push] Registration error:', err.error);
    });

    P.PushNotifications.addListener('pushNotificationReceived', notification => {
      if (window.Toast) {
        window.Toast.info(notification.title || notification.body || 'New notification');
      }
    });

    P.PushNotifications.addListener('pushNotificationActionPerformed', action => {
      const data = action.notification?.data || {};
      if (data.view && window.navigate) navigate(data.view);
    });
  }

  /* ── Haptic feedback ────────────────────────────── */
  function initHaptics() {
    if (!P.Haptics) return;
    document.addEventListener('click', e => {
      const btn = e.target.closest('.btn--primary, .btn--gold');
      if (btn) P.Haptics.impact({ style: 'LIGHT' }).catch(() => {});
    });
  }

  /* ── Back-button (Android) ──────────────────────── */
  function initBackButton() {
    if (!P.App) return;
    P.App.addListener('backButton', ({ canGoBack }) => {
      const modal = document.querySelector('.modal--open, .modal[style*="flex"]');
      if (modal) {
        if (window.Modal) Modal.closeAll();
        return;
      }
      if (!canGoBack) P.App.exitApp();
    });
  }

  /* ── App lifecycle ──────────────────────────────── */
  function initAppLifecycle() {
    if (!P.App) return;
    P.App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && window._refreshWalletUI) {
        _refreshWalletUI().catch(() => {});
      }
    });

    P.App.addListener('appUrlOpen', data => {
      const url = new URL(data.url);
      const view = url.pathname.replace(/^\/+/, '').split('/')[0];
      if (view && window.navigate) navigate(view);
    });
  }

  /* ── Init ───────────────────────────────────────── */
  async function init() {
    try {
      await initStatusBar();
      await initNetwork();
      initHaptics();
      initBackButton();
      initAppLifecycle();
      await initPush();

      if (document.readyState !== 'loading') {
        await hideSplash();
      } else {
        document.addEventListener('DOMContentLoaded', hideSplash);
      }

      console.log('[native] SV Capital native bridge initialised');
    } catch (err) {
      console.error('[native] Init error:', err);
      hideSplash().catch(() => {});
    }
  }

  init();
})();
