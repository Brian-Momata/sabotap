'use strict';

const CACHE = 'sabotap-v7';
const SHELL = [
  '/', '/index.html', '/style.css', '/manifest.webmanifest', '/icons/icon.svg',
  // Keep this list in sync with public/js/ — every module must be precached
  // or an installed PWA breaks offline after the next deploy.
  '/js/main.js', '/js/state.js', '/js/net.js', '/js/audio.js', '/js/ui.js',
  '/js/home.js', '/js/lobby.js', '/js/game-view.js', '/js/tournament-view.js',
  '/js/results.js', '/js/voice.js', '/js/voice-meter.js', '/js/install.js',
  '/js/handlers.js', '/js/board-themes.js', '/js/sabotage-fx.js',
  '/js/identity-ui.js',
];

self.addEventListener('install', e => {
  // Cache shell files individually and tolerate failures (e.g. requests that
  // race a sleeping free-tier host) — a partial cache beats a failed install.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u =>
        fetch(u).then(res => { if (res.ok) return c.put(u, res); })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first so updates land promptly; cache only good responses and fall
// back to cache when the network fails or the host is waking up.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        }
        return caches.match(e.request, { ignoreSearch: true }).then(hit => hit || res);
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || Response.error()))
  );
});
