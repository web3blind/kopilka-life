const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function worker(fetchRequest = async () => new Response('online'), clients = { matchAll: async () => [], openWindow: async () => {} }) {
  const listeners = new Map();
  const scope = {
    self: {
      location: { origin: 'https://life.blinddev.xyz' },
      addEventListener(type, callback) { listeners.set(type, callback); },
      registration: { showNotification: async () => {}, navigationPreload: { disable: async () => {} } },
      clients
    },
    fetch: fetchRequest,
    Response, URL
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/push-sw.js'), 'utf8'), scope);
  return listeners;
}

function dispatchFetch(listeners, url, options = {}) {
  let response;
  listeners.get('fetch')?.({
    request: { url, method: options.method || 'GET', mode: options.mode || 'navigate' },
    preloadResponse: Promise.resolve(options.preloaded),
    respondWith(value) { response = value; }
  });
  return response;
}

test('worker serves same-origin navigations from network, without intercepting API or cross-origin requests', async () => {
  const seen = [];
  const listeners = worker(async request => { seen.push(request.url); return new Response('online'); });
  assert.equal(typeof listeners.get('push'), 'function');
  assert.equal(typeof listeners.get('notificationclick'), 'function');
  const response = dispatchFetch(listeners, 'https://life.blinddev.xyz/');
  assert.equal(await (await response).text(), 'online');
  assert.deepEqual(seen, ['https://life.blinddev.xyz/']);
  assert.equal(dispatchFetch(listeners, 'https://life.blinddev.xyz/api/me', { mode: 'cors' }), undefined);
  assert.equal(dispatchFetch(listeners, 'https://other.example/page'), undefined);
  assert.equal(dispatchFetch(listeners, 'https://life.blinddev.xyz/', { method: 'POST' }), undefined);
});

test('worker disables speculative navigation preload and provides an explanatory offline response on network failure', async () => {
  let attempts = 0;
  const listeners = worker(async () => { attempts++; throw new TypeError('offline'); });
  let activation;
  listeners.get('activate')({ waitUntil(promise) { activation = promise; } });
  await activation;
  const fallback = await dispatchFetch(listeners, 'https://life.blinddev.xyz/');
  assert.equal(attempts, 1);
  assert.equal(fallback.status, 503);
  assert.match(await fallback.text(), /нет соединения/i);
});

test('click opens the standalone site even if a matching or VK window is already open', async () => {
  const calls = [];
  const clients = {
    matchAll: async () => [{ url: 'https://life.blinddev.xyz/', focus: async () => calls.push('old-focused') }],
    openWindow: async url => { calls.push(['open', url]); return { focus: async () => calls.push('new-focused') }; }
  };
  const listeners = worker(undefined, clients);
  let task;
  listeners.get('notificationclick')({ notification: { close: () => calls.push('closed') }, waitUntil: promise => { task = promise; } });
  await task;
  assert.deepEqual(calls, ['closed', ['open', 'https://life.blinddev.xyz/'], 'new-focused']);
});

test('click falls back to a normal site tab if the browser blocks opening a window', async () => {
  const calls = [];
  const clients = {
    openWindow: async () => { throw new Error('blocked'); },
    matchAll: async () => [
      { url: 'https://life.blinddev.xyz/?vk_app_id=54723764', focus: async () => calls.push('vk-focused') },
      { url: 'https://life.blinddev.xyz/profile', navigate: async url => { calls.push(['navigate', url]); return { focus: async () => calls.push('site-focused') }; } }
    ]
  };
  const listeners = worker(undefined, clients);
  let task;
  listeners.get('notificationclick')({ notification: { close() {} }, waitUntil: promise => { task = promise; } });
  await task;
  assert.deepEqual(calls, [['navigate', 'https://life.blinddev.xyz/'], 'site-focused']);
});
