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
    const isDark = document.body.classList.contains('dark-mode');
    await P.StatusBar.setStyle({ style: isDark ? 'DARK' : 'LIGHT' });
    await P.StatusBar.setBackgroundColor({ color: isDark ? '#0f1623' : '#ffffff' }).catch(() => {});
    await P.StatusBar.setOverlaysWebView({ overlay: false });
  }

  function syncStatusBar() {
    if (!P.StatusBar) return;
    const isDark = document.body.classList.contains('dark-mode');
    P.StatusBar.setStyle({ style: isDark ? 'DARK' : 'LIGHT' }).catch(() => {});
    P.StatusBar.setBackgroundColor({ color: isDark ? '#0f1623' : '#ffffff' }).catch(() => {});
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
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
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
    // Guard: only register push from the main portal page (index.html).
    // native.js is also loaded on login.html / signup.html so the API base
    // URL is available there, but calling register() on those pages and then
    // resolving the Android permission dialog before the portal WebView is
    // fully initialised causes a native crash. #view-overview only exists
    // in index.html, so this check is a reliable portal-page guard.
    if (!document.getElementById('view-overview')) return;

    // De-duplicate: native.js is re-executed on every WebView navigation
    // (login → portal redirect → index.html). Only register once per process.
    if (window.__SVC_PUSH_REGISTERED__) return;
    window.__SVC_PUSH_REGISTERED__ = true;

    try {
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
        // Reset flag so registration can be retried next session
        window.__SVC_PUSH_REGISTERED__ = false;
      });

      P.PushNotifications.addListener('pushNotificationReceived', notification => {
        if (window.Toast) {
          window.Toast.info(notification.title || notification.body || 'New notification');
        }
      });

      P.PushNotifications.addListener('pushNotificationActionPerformed', action => {
        const data = action.notification?.data || {};
        const view = data.view || data.section || data.tab;
        if (view && window.navigate) {
          setTimeout(() => { if (window.navigate) navigate(view); }, 500);
        }
      });
    } catch (e) {
      // Firebase / FCM not configured or not available on this device/emulator.
      // Reset so it can be retried after google-services.json is added.
      window.__SVC_PUSH_REGISTERED__ = false;
      console.warn('[push] Push notifications unavailable (is google-services.json present?):', e.message || e);
    }
  }

  /* ── Haptic feedback ────────────────────────────── */
  function initHaptics() {
    if (!P.Haptics) return;
    document.addEventListener('click', e => {
      // Primary / gold buttons: light impact
      if (e.target.closest('.btn--primary, .btn--gold')) {
        P.Haptics.impact({ style: 'LIGHT' }).catch(() => {});
      }
      // Bottom nav taps: selection feedback (iOS) or light impact
      if (e.target.closest('.mbn-item')) {
        P.Haptics.selectionStart().catch(() =>
          P.Haptics.impact({ style: 'LIGHT' }).catch(() => {})
        );
      }
    });
  }

  /* ── Back-button (Android) ──────────────────────── */
  function initBackButton() {
    if (!P.App) return;
    P.App.addListener('backButton', ({ canGoBack }) => {
      // Dismiss tour overlay — Android back is the natural dismiss gesture.
      const tour = document.getElementById('tourOverlay');
      if (tour && tour.style.display === 'block') {
        if (window.skipTour) window.skipTour();
        return;
      }
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
      if (isActive) {
        if (window._refreshWalletUI) _refreshWalletUI().catch(() => {});
        // Also refresh main data silently
        if (window.loadPortalData) loadPortalData().catch(() => {});
      }
    });

    P.App.addListener('appUrlOpen', data => {
      const url = new URL(data.url);
      const view = url.pathname.replace(/^\/+/, '').split('/')[0];
      if (view && window.navigate) navigate(view);
    });
  }

  /* ── Dark-mode status bar sync ──────────────────── */
  function initDarkModeSync() {
    // Observe body class changes triggered by toggleDarkMode()
    const observer = new MutationObserver(() => syncStatusBar());
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── Scroll-to-top when tapping already-active tab ── */
  function initNavScrollToTop() {
    document.addEventListener('click', e => {
      const item = e.target.closest('.mbn-item');
      if (!item || !item.classList.contains('active')) return;
      const content = document.querySelector('.page-content');
      if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  /* ── Loading cover ──────────────────────────────── */
  // In native mode the Capacitor SplashScreen (a true native overlay, not a
  // WebView div) covers the app while data loads. We hide it here after data
  // is ready. Using a native overlay avoids the Android WebView GPU compositing
  // bug where removing a position:fixed WebView element leaves content blank.
  function _hideCover() {
    // Hide the native splash screen — this is the primary loading cover.
    hideSplash().catch(() => {});
    // Also clear any legacy _nativeCover div (no-op when div is already hidden).
    const cover = document.getElementById('_nativeCover');
    if (cover) { cover.style.display = 'none'; setTimeout(() => { try { cover.remove(); } catch (_) {} }, 50); }
  }

  /* Expose globally so portal.js calls this after loadPortalData() resolves */
  window.__SVC_HIDE_COVER = _hideCover;

  /* Safety fallback: if portal.js never calls __SVC_HIDE_COVER (e.g. auth
     redirect, load failure), hide the splash after 12 s so the app isn't
     stuck on a splash screen forever. Railway cold-starts can take 5-8 s. */
  setTimeout(_hideCover, 12000);

  /* ── Init ───────────────────────────────────────── */
  async function init() {
    // Each plugin is wrapped independently — one failure must not block others.
    await initStatusBar().catch(e => console.warn('[native] StatusBar init failed:', e));
    await initNetwork().catch(e => console.warn('[native] Network init failed:', e));
    try { initHaptics();        } catch (e) { console.warn('[native] Haptics init failed:', e); }
    try { initDarkModeSync();   } catch (e) { console.warn('[native] DarkModeSync init failed:', e); }
    try { initNavScrollToTop(); } catch (e) { console.warn('[native] NavScrollToTop init failed:', e); }
    try { initBackButton();     } catch (e) { console.warn('[native] BackButton init failed:', e); }
    try { initAppLifecycle();   } catch (e) { console.warn('[native] AppLifecycle init failed:', e); }
    await initPush().catch(e => console.warn('[native] Push init failed:', e));

    // NOTE: hideSplash() is intentionally NOT called here.
    // The native SplashScreen stays visible until portal.js calls
    // window.__SVC_HIDE_COVER() after loadPortalData() resolves.
    // This ensures the WebView has fully rendered before the splash fades,
    // preventing the blank-screen compositing bug on Android.

    console.log('[native] SV Capital native bridge initialised');
  }

  init();
})();
