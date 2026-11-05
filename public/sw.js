/**
 * Service worker: offline support after the first load.
 *
 * Hand-written rather than generated, because the caching rules here are
 * genuinely unusual and a generic precache manifest would be the wrong shape:
 *
 *  - opencv.js is ~11 MB. It must be cached aggressively and never revalidated
 *    on a metered connection, but it also must not be precached on install,
 *    which would spend 11 MB of someone's data before they have tapped Start.
 *    So it is cached on first real use.
 *  - Vite hashes asset filenames, so /assets/* is immutable: cache-first with a
 *    quiet background refresh is safe and fastest.
 *  - The HTML pages are not hashed, so they are network-first with a cache
 *    fallback, or a deployment would never reach a returning visitor.
 *
 * Camera frames never touch this file, or any cache. Nothing here uploads
 * anything: there is no fetch to a third-party origin anywhere in the worker.
 */

const VERSION = 'v1';
const SHELL_CACHE = `marker-ar-shell-${VERSION}`;
const ASSET_CACHE = `marker-ar-assets-${VERSION}`;
const BIG_CACHE = `marker-ar-big-${VERSION}`;

const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, BIG_CACHE]);

/** Resolved against the worker's own scope, so it works under /<repo>/ on Pages. */
const SHELL = [
  './',
  './index.html',
  './marker.html',
  './calibrate.html',
  './bench.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Individually, so one 404 (a page that was not deployed) cannot fail the
      // whole install and leave the app with no worker at all.
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            const url = new URL(path, self.registration.scope).href;
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            // Offline during install, or the page does not exist. Not fatal.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) =>
          name.startsWith('marker-ar-') && !CURRENT_CACHES.has(name)
            ? caches.delete(name)
            : Promise.resolve(false),
        ),
      );
      await self.clients.claim();
    })(),
  );
});

/** Big, immutable, expensive: opencv.js, the glTF decoders, models. */
function isBigImmutable(pathname) {
  return (
    pathname.includes('/vendor/') ||
    pathname.includes('/decoders/') ||
    pathname.includes('/models/') ||
    pathname.endsWith('.wasm') ||
    pathname.endsWith('.glb')
  );
}

/** Vite's content-hashed output: safe to treat as immutable. */
function isHashedAsset(pathname) {
  return pathname.includes('/assets/');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Only cache a complete, successful, same-origin response. A 206 from a range
  // request would poison the cache with a partial body.
  if (response.ok && response.status === 200) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.status === 200) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (hit) {
    // Refresh in the background; do not make the user wait for it.
    network.catch(() => {});
    return hit;
  }
  const response = await network;
  if (response) return response;
  throw new Error('offline and not cached');
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok && response.status === 200) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Last resort for a navigation: the cached start page.
    const fallback = await cache.match(new URL('./index.html', self.registration.scope).href);
    if (fallback) return fallback;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch cross-origin requests, and never touch non-http schemes
  // (blob: and data: URLs are used for the screenshot and the marker SVG).
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // A range request must go straight to the network.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (isBigImmutable(url.pathname)) {
    event.respondWith(cacheFirst(request, BIG_CACHE));
    return;
  }

  if (isHashedAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});
