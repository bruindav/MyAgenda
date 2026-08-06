// Minimale service worker.
// Deze app werkt volledig live via Firebase (geen offline-modus), dus er
// wordt hier niets gecachet. De service worker bestaat puur omdat Android
// een geregistreerde service worker met een fetch-handler vereist om de
// app als "installeerbaar" (met eigen icoon + snelkoppelingen) te
// herkennen.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  // Gewoon altijd naar het netwerk — geen caching, geen offline-gedrag.
  event.respondWith(fetch(event.request));
});
