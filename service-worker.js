const CACHE_NAME = "anhad-offline-v9";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./core.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./og.png"
];
const scopeUrl = new URL("./", self.registration.scope).href;
const offlineUrl = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = APP_SHELL.map((path) => new Request(new URL(path, self.registration.scope), { cache: "reload" }));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          await Promise.all([cache.put(scopeUrl, response.clone()), cache.put(offlineUrl, response.clone())]);
        }
        return response;
      } catch {
        return await cache.match(event.request, { ignoreSearch: true })
          || await cache.match(offlineUrl)
          || await cache.match(scopeUrl)
          || new Response("Anhad no pudo abrirse offline.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(event.request).then(async (response) => {
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }).catch(() => cache.match(event.request, { ignoreSearch: true }));
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const requestedUrl = new URL(event.notification.data?.url || "./", self.registration.scope);
    const appUrl = new URL(scopeUrl);
    const targetUrl = requestedUrl.origin === appUrl.origin && requestedUrl.pathname.startsWith(appUrl.pathname)
      ? requestedUrl.href
      : scopeUrl;
    const anhadClient = clients.find((client) => {
      try {
        const clientUrl = new URL(client.url);
        return clientUrl.origin === appUrl.origin && clientUrl.pathname.startsWith(appUrl.pathname);
      } catch {
        return false;
      }
    });
    if (anhadClient) {
      return anhadClient.focus();
    }
    return self.clients.openWindow(targetUrl);
  }));
});

