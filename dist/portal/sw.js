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
      const match = ws.find(w => w.url.includes('/portal/'));
      return match ? match.focus() : clients.openWindow(url);
    })
  );
});
