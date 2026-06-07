const CACHE_NAME = 'dealer-tour-v1';
const API_CACHE = 'dealer-tour-api-v1';
const URLS_TO_CACHE = [
  '/dealer-tour.html',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png'
];

// Install service worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(URLS_TO_CACHE))
  );
});

// Activate service worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== API_CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests - network first, fallback to cache
  if (url.pathname.startsWith('/api')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            caches.open(API_CACHE).then(cache => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Static assets - cache first
    event.respondWith(
      caches.match(event.request)
        .then(response => response || fetch(event.request))
    );
  }
});
