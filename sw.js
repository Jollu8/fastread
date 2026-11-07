/* The application shell only: documents and custom audio remain in IndexedDB. */
"use strict";

const CACHE_PREFIX = "fastread-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v4`;
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "content-parser.js",
  "music-modes.js",
  "music-player.js",
  "assets/vendor/marked.min.js",
  "assets/vendor/pdf.min.js",
  "assets/vendor/pdf.worker.min.js",
  "assets/icon.svg",
  "manifest.webmanifest"
];
const SHELL_URLS = SHELL_FILES.map((path) => new URL(path, self.registration.scope).href);
const ALLOWED_PATHS = new Map(SHELL_URLS.map((url) => [new URL(url).pathname, url]));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const cacheKey = ALLOWED_PATHS.get(url.pathname);
  if (!cacheKey) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.status === 200 && response.type === "basic") {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(cacheKey, response.clone());
        } catch (_) {
          // A full device cache must not prevent a valid network response.
        }
      }
      return response;
    } catch (error) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      throw error;
    }
  })());
});
