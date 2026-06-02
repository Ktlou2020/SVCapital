'use strict';
const CACHE   = 'svc-portal-v1';
const PRECACHE = [
  './',
  './index.html',
  './js/portal.js',
  './css/portal.css',
  './css/portal-premium.css',
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
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
