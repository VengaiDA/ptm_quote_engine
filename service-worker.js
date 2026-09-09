/* PTM Quote Engine root PWA update boundary.
 *
 * Navigations always prefer a fresh network response with HTTP caching bypassed.
 * The versioned cache is only an offline fallback, so an installed Home Screen
 * app cannot keep executing an old index.html after a release.
 */
const BUILD_ID = '2026.09.09-p0.6';
const CACHE_NAME = `ptm-quote-engine-${BUILD_ID}`;
const PRESENTATION_SCRIPT = `./quote-presentation-approved.js?build=${BUILD_ID}`;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './quote-presentation-approved.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

async function injectApprovedPresentation(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('quote-presentation-approved.js')) {
    html = html.replace(
      '</body>',
      `  <script src="${PRESENTATION_SCRIPT}"></script>\n</body>`
    );
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
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('ptm-quote-engine-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();

    /* Force already-open root Quote Engine windows onto this release once.
     * This closes the iOS/Home Screen gap where the new service worker has
     * activated but the old document is still running in memory. */
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(async (client) => {
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin || url.pathname.includes('/agent-lite/')) return;
        if (url.searchParams.get('ptm-build') === BUILD_ID) return;
        url.searchParams.set('ptm-build', BUILD_ID);
        await client.navigate(url.href);
      } catch (_) {
        // A client that cannot be navigated can still refresh normally later.
      }
    }));
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/agent-lite/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(injectApprovedPresentation)
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
