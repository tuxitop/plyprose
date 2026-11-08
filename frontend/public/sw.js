// PlyProse Service Worker for PWA Offline Caching
const CACHE_NAME = 'plyprose-cache-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './chess.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache GitHub API calls or API endpoints
  if (url.hostname.includes('api.github.com') || url.pathname.includes('/api/')) {
    return;
  }

  // Network-first with cache fallback for HTML pages; Cache-first for assets
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful local GET asset responses
        if (response.status === 200 && event.request.method === 'GET' && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
