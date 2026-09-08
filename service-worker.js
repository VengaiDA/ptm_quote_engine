/* PTM Quote Engine root PWA update boundary.
 *
 * Navigations always prefer a fresh network response with HTTP caching bypassed.
 * The versioned cache is only an offline fallback, so an installed Home Screen
 * app cannot keep executing an old index.html after a release.
 */
const CACHE_NAME = 'ptm-quote-engine-2026-09-08-p0-2';
const TERMS_PATCH_SCRIPT = './root-terms-patch.js?build=2026.09.08-p0.2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './root-terms-patch.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

async function injectTermsPatch(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('root-terms-patch.js')) {
    html = html.replace('</body>', `  <script src="${TERMS_PATCH_SCRIPT}"></script>\n</body>`);
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('ptm-quote-engine-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/agent-lite/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(injectTermsPatch)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((response) => {
        if (response && response.ok && request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
