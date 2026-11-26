/* The Space shell is public markup. Protected documents, API data and writes
   stay network-only. The version changes when the shell is redeployed. */
const CACHE = 'stellar-public-v4-' + "__BUILD__";
const PUBLIC = ['/offline', '/app-assets/stellar-192.png', '/app-assets/stellar-512.png',
  '/app-assets/stellar-apple-touch-icon.png?v=2'];
const SHELL = '/space-shell';
const ASSETS = /* SPACE_ASSETS */ [];
const CACHED = [...new Set([...PUBLIC, SHELL, ...ASSETS])];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CACHED)).then(() => self.skipWaiting()));
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
    const space = (url.pathname === '/' || url.pathname === '/today') && !url.searchParams.has('tab_frame');
    event.respondWith((space ? caches.match(SHELL, { cacheName: CACHE }) : Promise.resolve(null))
      .then(shell => shell || fetch(request)).catch(() => caches.match('/offline', { cacheName: CACHE })));
  } else if (CACHED.includes(url.pathname + url.search)) {
    event.respondWith(caches.match(request, { cacheName: CACHE }).then(hit => hit || fetch(request)));
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
    if (requested.origin === self.location.origin) {
      if (requested.pathname === '/pool') target = requested;
      const day = requested.searchParams.get('day');
      if (requested.pathname === '/today' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
        target = new URL('/today?day=' + day + '&view=day', self.location.origin);
      }
    }
  } catch {}
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(client => client.frameType === 'top-level' && client.url.startsWith(self.location.origin + '/'));
    if (client) { await client.navigate(target.href); return client.focus(); }
    return self.clients.openWindow(target.href);
  }));
});
