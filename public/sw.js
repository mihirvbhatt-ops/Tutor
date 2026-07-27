// Bump this version any time you deploy changes.
// For a localhost app the version doesn't matter much because
// we use network-first below — but it clears any old caches on activate.
const CACHE = 'tutor-shell-v4';

self.addEventListener('install', e => {
  // Take over immediately without waiting for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete every old cache version
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // control all open tabs right away
  );
});

self.addEventListener('fetch', e => {
  // Never intercept API calls — always go straight to the network
  if (e.request.url.includes('/api/')) return;

  // Network-first for everything else:
  // 1. Try the network → if it succeeds, update the cache and return fresh response
  // 2. If offline/unreachable, fall back to whatever is cached
  // This means you ALWAYS get the latest version when connected,
  // and the cache only kicks in if you lose connectivity.
  e.respondWith(
    fetch(e.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
