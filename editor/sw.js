// Preview of the edited site at preview/…: editor.js puts the files (HTML already
// with annotations and the overlay) into Cache Storage; this only serves them.
// That makes folders, images, relative links and multiple pages work.

const CACHE = 'webai-demo-preview';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // The overlay, CDN fonts etc. go over the network as usual.
  if (!url.href.startsWith(self.registration.scope)) return;
  if (url.pathname.endsWith('/')) url.pathname += 'index.html';
  url.search = '';
  e.respondWith(
    caches
      .open(CACHE)
      .then((c) => c.match(url.href))
      .then(
        (res) =>
          res ??
          new Response(`<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:2rem">File ${url.pathname.split('/preview/').pop()} is not in the site.</p>`, {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
  );
});
