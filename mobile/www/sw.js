'use strict';
const CACHE   = 'svc-portal-v111';
const PRECACHE = [
  './',
  './index.html',
  './js/portal.js',
  './css/portal.css',
  './css/portal-premium.css',
  './css/mobile-app.css',
  '../js/api.js',
  '../css/admin.css',
  '../css/ci-theme.css',
  '../assets/logo-192.png',
  '../assets/logo.png',
  '../assets/favicon.ico',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  // Always network-first for API calls
  if (request.url.includes('/api/')) return;

  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        if (res.ok && res.status < 400) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached || (request.mode === 'navigate'
        ? caches.match('./index.html')
        : undefined));
      return cached || networkFetch;
    })
  );
});

// ── Push notification handler ──────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {
    title: 'SV Capital',
    body:  'You have a new notification',
    url:   '/portal/',
    icon:  '/assets/logo.png',
    badge: '/assets/logo.png',
  };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch (_) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:               data.body,
      icon:               data.icon  || '/assets/logo.png',
      badge:              data.badge || '/assets/logo.png',
      tag:                data.tag   || 'sv-capital',
      data:               { url: data.url || '/portal/' },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/portal/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.includes('/portal'));
      if (match) return match.focus();
      return clients.openWindow(url);
    })
  );
});
