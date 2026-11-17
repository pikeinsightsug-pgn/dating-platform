// P.K CONNECT app helper. Pages always load fresh from the network, so members never see
// out-of-date pages; the only thing kept offline is a small "you are offline" page.
// For speed on slow mobile data, files that rarely change are kept on the phone after the first
// visit: the versioned Supabase library and fonts are reused as-is, and pictures are shown from
// the phone at once while a fresh copy is fetched quietly in the background.
// Supabase requests (logins, profiles, messages, photos) are never touched.
// Phone pop-up notifications for new messages (OneSignal). If it cannot load, the rest of
// this helper still works.
try { importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js"); } catch (error) { /* optional */ }
const CACHE = "pk-connect-offline-v1";
const OFFLINE = "offline.html";
const STATIC = "pk-connect-static-v1";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, "assets/app/icon-192.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== STATIC).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
function isFixedFile(path) { return path.startsWith("/assets/vendor/") || path.startsWith("/assets/fonts/"); }
function isPicture(path) { return path.startsWith("/assets/") && /\.(png|jpe?g|webp|svg|ico)$/i.test(path); }

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "GET" && url.origin === self.location.origin && !url.search && (isFixedFile(url.pathname) || isPicture(url.pathname))) {
    event.respondWith(caches.open(STATIC).then(async cache => {
      const cached = await cache.match(request);
      const fresh = fetch(request).then(response => {
        if (response && response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      });
      if (cached) {
        if (!isFixedFile(url.pathname)) event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }));
    return;
  }
  // Only page visits on this website; everything else goes straight to the network as before.
  if (request.mode !== "navigate" || request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
});
