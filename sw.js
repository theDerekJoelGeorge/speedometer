/**
 * Service worker scaffold for future PWA offline support.
 * Currently passes through all requests — extend when adding caching.
 */

const CACHE_NAME = "gps-speedometer-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
