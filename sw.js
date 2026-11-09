// オフライン起動用。アプリ本体のファイルだけをキャッシュする（記録データは扱わない）
const VERSION = 'atode-16572497756a';
const FILES = ["./","./app.js","./apple-touch-icon.png","./chunk-DCPZTHJ7.js","./chunk-EK26F3FQ.js","./chunk-PKQXD6YS.js","./chunk-UVF2BVF4.js","./icon-192.png","./icon-512.png","./index.html","./manifest.webmanifest","./pdf.worker.min.js"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => caches.match('./index.html'))),
  );
});
