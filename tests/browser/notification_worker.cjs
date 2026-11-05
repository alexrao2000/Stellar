/* The service worker displays pushes and confines click navigation to Stellar. */
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const handlers = {}, shown = [], opened = [];
const self = { location: { origin: 'https://stellar.invalid' },
  addEventListener: (type, fn) => handlers[type] = fn,
  registration: { showNotification: async (...args) => shown.push(args) },
  clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
};
vm.runInNewContext(readFileSync('scripts/static/sw.js', 'utf8'), { self, URL });
async function event(type, extras) {
  let complete; handlers[type]({ ...extras, waitUntil: work => complete = work }); await complete;
}
(async () => {
  const payload = { title: 'Stellar', body: 'Demo star', tag: 'star-7', url: '/pool?star=7' };
  await event('push', { data: { json: () => payload } });
  assert.equal(shown[0][1].body, 'Demo star');
  assert.equal(shown[0][1].tag, 'star-7');
  await event('notificationclick', { notification: { close() {}, data: { url: '/pool?star=7' } } });
  assert.equal(opened.pop(), 'https://stellar.invalid/pool?star=7');
  await event('notificationclick', { notification: { close() {}, data: { url: 'https://outside.invalid/pool' } } });
  assert.equal(opened.pop(), 'https://stellar.invalid/pool');
  let navigated, focused = false;
  self.clients.matchAll = async () => [
    { frameType: 'nested', url: 'https://stellar.invalid/pool?embedded=true', navigate() { throw Error('Must not navigate an iframe'); } },
    { frameType: 'top-level', url: 'https://stellar.invalid/metrics', navigate: async url => navigated = url, focus: async () => focused = true },
  ];
  await event('notificationclick', { notification: { close() {}, data: { url: '/pool?star=7' } } });
  assert.equal(navigated, 'https://stellar.invalid/pool?star=7'); assert(focused);
  await event('push', { data: { json() { throw Error('Malformed data'); } } });
  assert.equal(shown[1][0], 'Stellar');
  await event('push', { data: { json: () => null } });
  assert.equal(shown[2][0], 'Stellar');
  console.log('Notification display, deep links, existing-window focus and safe fallback passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
