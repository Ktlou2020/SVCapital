/* ═══════════════════════════════════════════════════════════════
   SV Capital — Service Worker (PWA Offline Support)
   Version: 1.0.0
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME  = 'svcapital-fund-v3';
const STATIC_URLS = [
  '/fund/index.html',
  '/fund/cattle.html',
  '/fund/js/fund.js',
  '/fund/js/cattle.js',
  '/assets/logo.svg',
  '/assets/logo-inline.svg',
  '/assets/svcapital-logo-header.png'
];

/* ── Install: pre-cache static shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
      .then(() => self.skipWaiting())
      .catch(err => {
        /* Non-fatal: some assets may not be available during install */
        console.warn('[SW] Pre-cache partial failure:', err.message);
      })
  );
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch strategy: Network-first, fall back to cache ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  /* Pass-through for API calls — never cache API responses */
  if (url.pathname.startsWith('/api/')) {
    return; /* Let it fall through to network */
  }

  /* For same-origin GET requests: network-first with cache fallback */
  if (event.request.method !== 'GET') return;
  if (!url.origin.includes(self.location.origin) && !url.origin.includes('jsdelivr') && !url.origin.includes('googleapis') && !url.origin.includes('fontawesome')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        /* Only cache successful same-origin responses */
        if (response && response.status === 200 && url.origin === self.location.origin) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => {
        /* Network failed — serve from cache */
        return caches.match(event.request)
          .then(cached => {
            if (cached) return cached;
            /* Final fallback for navigation requests */
            if (event.request.mode === 'navigate') {
              return caches.match('/fund/index.html');
            }
            return new Response('', { status: 503, statusText: 'Service Unavailable' });
          });
      })
  );
});

/* ── Message handler for cache invalidation ── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME);
  }
});
