// Minimal service worker: makes the app installable and keeps the static
// shell available offline. Deliberately never caches /api/* — this app
// leans on live polling for order/runner state, so a cached API response
// would be actively misleading, not just stale.
const CACHE_NAME = "novadash-v4";
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

// Shows the actual OS-level notification a push payload asks for — this is
// what fires even when the app's closed or the phone's locked. The server
// sends {title, body, url} as JSON (see sendPushToUser in server.js).
self.addEventListener("push", (event) => {
  let data = { title: "NovaDash", body: "You have a new message.", url: "/messages.html" };
  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch (e) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url }
    })
  );
});

// Focuses an already-open tab on that URL if one exists, otherwise opens a
// new one — the standard "click a notification" behavior.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/messages.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).pathname === url && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
