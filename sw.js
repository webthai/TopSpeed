const CACHE_NAME = 'trip-tracker-v2';
const TILE_CACHE_NAME = 'trip-tracker-tiles-v1';
const LIB_CACHE_NAME = 'trip-tracker-libs-v1';

const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Third-party assets the app actually NEEDS to render (Leaflet + fonts), pinned to an exact
// version so they never need to change once cached. Precached greedily on install so a fresh
// install works fully offline right after its first successful online launch — not only after
// the user happens to have visited every screen once while connected.
const LIB_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
      caches.open(LIB_CACHE_NAME).then((cache) =>
        // Each URL cached independently — if the device happens to install while offline (or one
        // CDN hiccups), that one asset is just skipped instead of failing the whole install; it
        // gets cached the moment it's fetched successfully at runtime instead.
        Promise.all(LIB_ASSETS.map((url) => cache.add(url).catch(() => {})))
      )
    ])
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![CACHE_NAME, TILE_CACHE_NAME, LIB_CACHE_NAME].includes(k)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App-shell files: stale-while-revalidate (instant load, refreshes in background).
// Map tiles + Leaflet/fonts: cache-first (once seen, reused forever — fast + works offline).
// Everything else (Google Sheets sync): network passthrough.
const TILE_HOST_RE = /tile\.openstreetmap\.org$/;
const LIB_HOST_RE = /^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === self.location.origin;
  const isTile = TILE_HOST_RE.test(url.hostname);
  const isLib = LIB_HOST_RE.test(url.hostname);

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

  // NOTE: cross-origin requests made by plain <link>/<script> tags (no crossorigin attribute)
  // come through here as "opaque" responses — status is always reported as 0 and res.ok is
  // always false, even on success. Caching must NOT gate on res.ok for these; it would silently
  // never cache anything. Only a thrown fetch (actually offline) counts as failure here.
  if (isTile) {
    e.respondWith(
      caches.open(TILE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached; // cache-first: tiles don't change, so a hit is served instantly
        try {
          const res = await fetch(e.request);
          cache.put(e.request, res.clone()).catch(() => {});
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  if (isLib) {
    e.respondWith(
      caches.open(LIB_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        try {
          const res = await fetch(e.request);
          cache.put(e.request, res.clone()).catch(() => {});
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
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
