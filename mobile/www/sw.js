/* SV Capital — Minimal service worker (push handler only).
   Offline caching / PWA install removed — Capacitor handles native delivery. */
'use strict';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(
  // Clear any legacy caches left from the old PWA setup
  caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

/* ── Push notifications (web browser only) ─────────────────────────── */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title   = data.title   || 'SV Capital';
  const options = {
    body:    data.body    || 'You have a new notification.',
    icon:    data.icon    || '/assets/sv-capital-logo-horizontal-white-text.png',
    badge:   data.badge   || '/assets/sv-capital-logo-horizontal-white-text.png',
    data:    { url: data.url || '/portal/' },
    vibrate: [200, 100, 200],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/portal/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
      /* FOCUS WAS NOT ENOUGH. An open portal tab was brought to the front
         and the url thrown away, so a notification about one stokvel left
         the reader wherever they happened to be \u2014 which is why deep links
         appeared not to work rather than appearing to be missing. The page
         is told where to go and routes there itself, keeping its state;
         navigate() is the fallback for a page too old to listen. */
      const match = ws.find(w => w.url.includes('/portal/'));
      if (!match) return clients.openWindow(url);
      match.postMessage({ type: 'svc-open', url });
      return match.focus();
    })
  );
});
