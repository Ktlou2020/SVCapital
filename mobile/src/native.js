/**
 * SV Capital — Capacitor native bridge
 * Injected into the portal WebView to wire up native features.
 * Runs only when window.__SVC_NATIVE__ === true.
 */
'use strict';

import { App }                  from '@capacitor/app';
import { StatusBar, Style }     from '@capacitor/status-bar';
import { SplashScreen }         from '@capacitor/splash-screen';
import { Network }              from '@capacitor/network';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { PushNotifications }    from '@capacitor/push-notifications';
import { LocalNotifications }   from '@capacitor/local-notifications';

/* ── Status bar ─────────────────────────────────── */
async function initStatusBar() {
  await StatusBar.setStyle({ style: Style.Dark });
  await StatusBar.setBackgroundColor({ color: '#0f1623' });
  await StatusBar.setOverlaysWebView({ overlay: false });
}

/* ── Splash screen ──────────────────────────────── */
async function hideSplash() {
  await SplashScreen.hide({ fadeOutDuration: 300 });
}

/* ── Network monitoring ─────────────────────────── */
async function initNetwork() {
  const status = await Network.getStatus();
  if (!status.connected) showOfflineBanner();

  Network.addListener('networkStatusChange', s => {
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
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt') {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== 'granted') return;

  await PushNotifications.register();

  PushNotifications.addListener('registration', async token => {
    // Send FCM/APNs token to backend so server can address this device
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
        body: JSON.stringify({ token: token.value, platform: window.Capacitor?.getPlatform() }),
      });
    } catch (_) {}
  });

  PushNotifications.addListener('registrationError', err => {
    console.warn('[push] Registration error:', err.error);
  });

  PushNotifications.addListener('pushNotificationReceived', notification => {
    // App is foregrounded — show an in-app toast instead of system notification
    if (window.Toast) {
      Toast.info(notification.title || notification.body || 'New notification');
    }
  });

  PushNotifications.addListener('pushNotificationActionPerformed', action => {
    const data = action.notification?.data || {};
    // Deep-link to a view based on notification payload
    if (data.view && window.navigate) {
      navigate(data.view);
    }
  });
}

/* ── Haptic feedback hook ───────────────────────── */
function initHaptics() {
  // Add haptic feedback to primary buttons
  document.addEventListener('click', e => {
    const btn = e.target.closest('.btn--primary, .btn--gold');
    if (btn) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  });
}

/* ── Back-button handling (Android) ─────────────── */
function initBackButton() {
  App.addListener('backButton', ({ canGoBack }) => {
    const modal = document.querySelector('.modal--open, .modal[style*="flex"]');
    if (modal) {
      // Close the open modal instead of going back
      if (window.Modal) Modal.closeAll();
      return;
    }
    if (!canGoBack) App.exitApp();
  });
}

/* ── App lifecycle ──────────────────────────────── */
function initAppLifecycle() {
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      // Refresh wallet balance when user returns to app
      if (window._refreshWalletUI) _refreshWalletUI().catch(() => {});
    }
  });

  App.addListener('appUrlOpen', data => {
    // Handle deep links: svcapital://investor/view/wallet
    const url = new URL(data.url);
    const view = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (view && window.navigate) navigate(view);
  });
}

/* ── Init ───────────────────────────────────────── */
(async () => {
  try {
    await initStatusBar();
    await initNetwork();
    initHaptics();
    initBackButton();
    initAppLifecycle();
    await initPush();

    // Wait for the portal's DOMContentLoaded before hiding splash
    if (document.readyState !== 'loading') {
      await hideSplash();
    } else {
      document.addEventListener('DOMContentLoaded', hideSplash);
    }

    console.log('[native] SV Capital native bridge initialised');
  } catch (err) {
    console.error('[native] Init error:', err);
    await hideSplash().catch(() => {});
  }
})();
