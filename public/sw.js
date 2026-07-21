// Minimal network-first service worker for the app shell (spec §3) — falls
// back to the cache only when offline. A cache-first strategy was tried
// first, but it meant every deploy after a visitor's first load was
// invisible to them forever (the cached index.html keeps pointing at old
// hashed JS/CSS filenames, and nothing ever re-checks the network to notice
// a new deploy exists). Network-first fixes that while keeping basic
// offline support via the cache fallback.
// Only handles same-origin GET requests; API calls and Spotify/Anthropic
// requests always go to the network.

const CACHE_NAME = 'frequency-shell-v2';
const PRECACHE_URLS = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isApiCall = url.pathname.startsWith('/api/');

  if (event.request.method !== 'GET' || !isSameOrigin || isApiCall) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
