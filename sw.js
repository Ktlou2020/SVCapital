'use strict';

const CACHE_NAME = 'svc-shell-v1';

const SHELL_FILES = [
  '/',
  '/portal/',
  '/portal/index.html',
  '/js/api.js',
  '/css/portal.css',
  '/portal/js/portal.js',
  '/portal/css/portal.css',
  '/portal/css/portal-premium.css',
  '/css/admin.css',
  '/css/ci-theme.css',
];

/* ── Install: pre-cache shell files ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: delete old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: network-first for /api/, cache-first for everything else ── */
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Always fetch from network for API calls — never cache
  if (request.url.includes('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first strategy: try cache, fall back to network (and cache the result)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Only cache valid responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: return cached portal page for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/portal/index.html') || caches.match('/portal/');
        }
      });
    })
  );
});
