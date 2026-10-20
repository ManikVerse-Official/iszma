/*
 * ReportCard Studio service worker.
 *
 * Scope is intentionally narrow: the app is a local-first tool, so student data
 * never leaves the device and the worker only caches the application shell so
 * the installed app opens instantly (and works offline).
 *
 * Generated PDFs / ZIPs are produced in-page from Blob URLs and are never
 * intercepted here, so downloads keep working on desktop and Android Chrome.
 */

/*
 * Bump this whenever the shell policy changes.
 *
 * v1 could pin a stale build: the navigation handler reused whatever the HTTP
 * cache handed back, and a single failed fetch (dev server restarting, flaky
 * network) made it fall back to the CACHED index.html — which points at the
 * build's old hashed asset names, which the asset cache still held. The result
 * was a user who kept seeing an old Studio after a new build had shipped.
 *
 * v2 fixes both halves: navigations are fetched with `cache: 'no-store'` (so an
 * online visit always gets the deployed shell) and hashed assets are
 * stale-while-revalidate (instant, but refreshed for the next load).
 */
const CACHE = 'reportcard-studio-shell-v2';

/* Only the shell is precached. Hashed build assets are cached on first use. */
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * Navigations: always the deployed shell when online (no-store skips the HTTP
   * cache too), with the cached copy only as the offline fallback.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html'))),
    );
    return;
  }

  /*
   * Static assets: stale-while-revalidate. The cached copy answers instantly
   * (offline still works), and the network response refreshes the entry for the
   * next load, so a cached asset can never stay pinned to an old build.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    }),
  );
});
