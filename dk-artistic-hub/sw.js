// Network-first cache: the site opens offline and updates show up fast.
// Supabase calls are cross-origin and are never cached. Bump VERSION after big edits.
var VERSION = "dk-app-v1";
var FILES = ["./", "index.html", "track.html", "admin.html", "terms.html", "404.html", "assets/app.css", "assets/core.js", "assets/store.js", "assets/track.js", "assets/admin.js", "icon.svg", "manifest.webmanifest"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); })); self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (x) { return x !== VERSION; }).map(function (x) { return caches.delete(x); })); }));
  self.clients.claim();
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(function (res) { var c = res.clone(); caches.open(VERSION).then(function (k) { k.put(e.request, c); }); return res; }).catch(function () { return caches.match(e.request); }));
});
