// Bump CACHE when you deploy changes, so installed apps pick up the new files.
const CACHE = "okonomi-v38";
const CDN = "https://esm.sh";
const APP_FILES = [
  "./", "index.html", "app.js", "styles.css", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Libraries from the CDN are versioned and never change: cache first.
  if (url.origin === CDN) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // The app's own files: network first so updates arrive, cache when offline. "no-cache" makes the
  // browser ask GitHub every time (a cheap 304 when nothing changed) instead of reusing its HTTP cache,
  // which GitHub Pages allows for 10 minutes and which kept serving old versions after an update.
  // A navigation Request can't be copied with options, so it is fetched by URL.
  if (url.origin === self.location.origin) {
    const fresh = req.mode === "navigate" ? fetch(req.url, { cache: "no-cache" }) : fetch(req, { cache: "no-cache" });
    e.respondWith(
      fresh.then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
    );
  }
});
