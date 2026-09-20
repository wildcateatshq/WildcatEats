// Minimal service worker: makes the app installable and keeps the static
// shell available offline. Deliberately never caches /api/* — this app
// leans on live polling for order/runner state, so a cached API response
// would be actively misleading, not just stale.
const CACHE_NAME = "novadash-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/order.html",
  "/deliver.html",
  "/messages.html",
  "/settings.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/wildcat-eats-logo.png",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first, falling back to cache when offline — keeps live data live
// when there's a connection, and still renders the shell when there isn't.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
