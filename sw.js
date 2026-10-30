// Makes the app installable and lets it open without a connection. Pages are fetched from
// the network first, so updates show up right away; the cache is only a fallback.
// Requests to Google (Gemini) are never cached.
const CACHE = "live-translate-v2";
const SHELL = [
  "./", "index.html", "app.js", "gemini.js", "audio-worklet.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
  "https://cdn.jsdelivr.net/npm/@google/genai@2.29.1/+esm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const cacheable = event.request.method === "GET"
    && (url.origin === self.location.origin || url.hostname === "cdn.jsdelivr.net");
  if (!cacheable) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
