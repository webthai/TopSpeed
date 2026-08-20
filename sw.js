const CACHE_NAME = 'trip-tracker-v1';
const TILE_CACHE_NAME = 'trip-tracker-tiles-v1';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App-shell files: stale-while-revalidate (instant load, refreshes in background).
// Map tiles: cache-first (once a tile is seen, it's reused forever — fast + works offline).
// Everything else (Leaflet CDN, Sheets sync): network passthrough.
const TILE_HOST_RE = /tile\.openstreetmap\.org$/;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === self.location.origin;
  const isTile = TILE_HOST_RE.test(url.hostname);

  if (isShell) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fetchPromise = fetch(e.request)
          .then((res) => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  if (isTile) {
    e.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached; // cache-first: tiles don't change, so a hit is served instantly
        try {
          const res = await fetch(e.request);
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
  }
  // Everything else falls through to the network normally.
});

// Lets the app ask how many tiles are cached, or clear them, from Settings.
self.addEventListener('message', (e) => {
  if (e.data?.type === 'TILE_CACHE_COUNT') {
    caches.open(TILE_CACHE_NAME).then((cache) =>
      cache.keys().then((keys) => e.ports[0].postMessage({ count: keys.length }))
    );
  }
  if (e.data?.type === 'TILE_CACHE_CLEAR') {
    caches.delete(TILE_CACHE_NAME).then(() => e.ports[0].postMessage({ ok: true }));
  }
});
