// P.K CONNECT app helper. Pages always load fresh from the network, so members never see
// out-of-date pages; the only thing kept offline is a small "you are offline" page.
// Supabase requests (logins, profiles, messages, photos) are never touched.
const CACHE = "pk-connect-offline-v1";
const OFFLINE = "offline.html";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, "assets/app/icon-192.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  // Only page visits on this website; everything else goes straight to the network as before.
  if (request.mode !== "navigate" || request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
});
