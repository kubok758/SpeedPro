/**
 * SpeedCheck — service-worker.js
 * Caches the app shell for offline support.
 * Speed test itself requires internet (by design).
 */

const CACHE_NAME = 'speedcheck-v1';

// Files to cache for offline shell
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ─── Install: cache shell ─────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_FILES).catch((err) => {
        console.warn('Cache addAll partial fail (some assets may not exist yet):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: Shell = cache-first, Speed test = network-only ───────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Speed test API calls — always go to network, never cache
  if (url.hostname === 'speed.cloudflare.com' || url.pathname.startsWith('/__down') || url.pathname.startsWith('/__up')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Google Fonts — network first, fallback to cache
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell — cache first, network fallback
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful same-origin responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // If both cache and network fail, return offline page
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
