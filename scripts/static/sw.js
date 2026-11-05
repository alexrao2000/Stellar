/* Cache only public installation files. Private pages and API data never enter
   Cache Storage, and failed writes are never queued or reported as saved. */
const CACHE = 'stellar-public-v3';
const PUBLIC = ['/offline', '/app-assets/stellar-192.png', '/app-assets/stellar-512.png',
  '/app-assets/stellar-apple-touch-icon.png?v=2'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => (key.startsWith('task-tracker-public-') || key.startsWith('stellar-public-')) && key !== CACHE)
      .map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
  } else if (PUBLIC.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
  }
});

self.addEventListener('push', event => {
  let payload = {};
  try { const data = event.data ? event.data.json() : {}; if (data && typeof data === 'object') payload = data; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title || 'Stellar', {
    body: payload.body || 'You have a star reminder.',
    icon: '/app-assets/stellar-192.png', badge: '/app-assets/stellar-192.png',
    tag: payload.tag || 'stellar-reminder', data: { url: payload.url || '/pool' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = new URL('/pool', self.location.origin);
  try {
    const requested = new URL(event.notification.data?.url || '/pool', self.location.origin);
    if (requested.origin === self.location.origin && requested.pathname === '/pool') target = requested;
  } catch {}
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(client => client.frameType === 'top-level' && client.url.startsWith(self.location.origin + '/'));
    if (client) { await client.navigate(target.href); return client.focus(); }
    return self.clients.openWindow(target.href);
  }));
});
