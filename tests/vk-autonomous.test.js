'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');
// No DB/provider/network: exercise the actual generated popup script.
const configPath = require.resolve('../src/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { webappUrl: 'https://life.example' } };
const { buildOAuthWindowDocument, buildOAuthCallbackDocument } = require('../src/auth/vkOAuth');
const origin = 'https://life.example';
const channel = 'c'.repeat(48);
async function popup(input, response, fetchError) {
  const window = { name: JSON.stringify(input), opener: { closed: false, postMessage: (data, target) => messages.push({ data, target }) } };
  const stored = new Map();
  const requests = [], messages = [], navigations = [];
  let expire;
  const status = { textContent: '' };
  const document = buildOAuthWindowDocument();
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(document.html)[1];
  const ctx = vm.createContext({ Date, URL, AbortController,
    setTimeout: fetchError === 'timeout' ? (callback, delay) => { assert.equal(delay, 15000); expire = callback; return 1; } : setTimeout,
    clearTimeout: fetchError === 'timeout' ? () => {} : clearTimeout,
    sessionStorage: { getItem: key => stored.get(key), removeItem: key => stored.delete(key) },
    document: { getElementById: () => status },
    location: { origin, replace: url => navigations.push(url) },
    window,
    fetch: async (url, options) => {
      assert.equal(window.name, '', 'bootstrap secret is erased before network');
      requests.push({ url, options });
      if (fetchError === 'timeout') return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Error('aborted')));
        expire();
      });
      if (fetchError) throw Error('network');
      return { ok: response.ok !== false, json: async () => response };
    }
  });
  await vm.runInContext(script, ctx);
  return { window, stored, requests, messages, navigations, status, document };
}
const context = action => ({ action, channel, createdAt: Date.now(), token: 'private-session', refCode: 'REF123', timezone: 'Europe/Moscow', locale: 'en' });
const response = { channel, launchUrl: origin + '/api/auth/vk-oauth/start?intent=' + 'i'.repeat(32) };
test('autonomous popup owns intent request and navigation, preserves link/referral/locale without URL bearer', async () => {
  for (const action of ['auth', 'link']) {
    const result = await popup(context(action), response);
    assert.equal(result.window.name, '');
    assert.equal(result.requests.length, 1);
    const { url, options } = result.requests[0];
    assert.equal(url, '/api/auth/vk-oauth/intent');
    assert.equal(options.headers.authorization, action === 'link' ? 'Bearer private-session' : undefined);
    assert.deepEqual(JSON.parse(options.body), { action, channel, refCode: 'REF123', timezone: 'Europe/Moscow', locale: 'en' });
    assert.deepEqual(result.navigations, [response.launchUrl]);
    assert.equal(result.messages.length, 0);
  }
});
test('popup rejects absent/expired/link-without-session bootstrap and exposes an actionable error', async () => {
  for (const input of [null, { ...context('auth'), createdAt: 1 }, { ...context('link'), token: '' }]) {
    const result = await popup(input, response);
    assert.equal(result.requests.length, 0);
    assert.equal(result.navigations.length, 0);
    assert.match(result.status.textContent, /попробуйте снова/);
    assert.equal(result.window.name, '');
  }
});
test('intent failures, mismatched channels and external launches never navigate; errors use exact-origin correlated handoff', async () => {
  for (const data of [{ ...response, ok: false }, { ...response, channel: 'wrong' }, { ...response, launchUrl: 'https://evil.example/' }, { ...response, launchUrl: origin + '/api/auth/vk-oauth/start' }]) {
    const result = await popup(context('link'), data);
    assert.equal(result.navigations.length, 0);
    assert.equal(result.messages[0].target, origin);
    assert.equal(result.messages[0].data.channel, channel);
    assert.equal(result.messages[0].data.action, 'link');
    assert.equal(result.messages[0].data.token, undefined);
  }
  assert.equal((await popup(context('auth'), response, true)).navigations.length, 0);
});
test('a hanging popup intent is aborted and returns a correlated error instead of waiting forever', async () => {
  const result = await popup(context('auth'), response, 'timeout');
  assert.equal(result.requests[0].options.signal.aborted, true);
  assert.equal(result.navigations.length, 0);
  assert.equal(result.messages[0].data.channel, channel);
  assert.match(result.status.textContent, /попробуйте снова/);
});
function client() {
  const stored = new Map(), elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  let snapshot;
  const popup = { closed: false, postMessage() {}, close() { this.closed = true; } };
  const window = { location: { origin, href: origin + '/', search: '', hash: '' }, localStorage: {},
    open(url, name) { assert.equal(url, '/api/auth/vk-oauth/window'); snapshot = JSON.parse(name); return popup; },
    setInterval() { return 1; }, clearInterval() {}, addEventListener() {} };
  const ctx = vm.createContext({ window, document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null, body: {} }, console, URL, URLSearchParams, Intl, Date, crypto: crypto.webcrypto,
    sessionStorage: { setItem: (k, v) => stored.set(k, v), getItem: k => stored.get(k), removeItem: k => stored.delete(k) },
    navigator: {}, AbortController, setTimeout, clearTimeout, fetch() { throw Error('opener must not fetch'); } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'), ctx);
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async () => {\n  fireVkBridgeInit();')), ctx);
  return { ctx, window, stored, popup, el, snapshot: () => snapshot, run: code => vm.runInContext(code, ctx) };
}
test('opener bootstraps synchronously, removes secrets, and rejects source/origin/channel/action mismatches', async () => {
  const c = client();
  c.run("state.token='original-session'; captureRefCode=()=> 'REF'; detectTimezone=()=> 'UTC'; api=()=> {throw Error('no opener async request allowed')};");
  await c.run("startVkOAuth('link')");
  assert.equal(c.snapshot().token, 'original-session');
  assert.equal(c.snapshot().action, 'link');
  assert.equal(c.stored.size, 0);
  const expected = c.run('state.vkOAuthChannel');
  for (const change of [{ origin: 'https://evil.example' }, { source: {} }, { data: { channel: 'wrong' } }, { data: { action: 'auth' } }]) {
    c.ctx.event = { origin, source: c.popup, data: { type: 'kopilka:vk-oauth', action: 'link', channel: expected, linkProof: 'proof' }, ...change };
    await c.run('receiveVkOAuthHandoff(event)');
    assert.equal(c.run('state.vkOAuthWindow'), c.popup);
    assert.equal(c.run('state.token'), 'original-session');
  }
});

async function callbackPage({ hidden = false, prerender = false, failure = false } = {}) {
  const requests = [], stored = new Map([['kopilkaVkOAuthHandoff', 'existing-success']]), messages = [], listeners = new Map();
  const status = { textContent: '' };
  const doc = { visibilityState: hidden ? 'hidden' : 'visible', prerendering: prerender,
    getElementById: () => status, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const window = { opener: { closed: false, postMessage: (data, target) => messages.push({ data, target }) }, addEventListener() {}, setTimeout: () => 1, close() {}, location: { replace() {} } };
  window.top = window;
  const generated = buildOAuthCallbackDocument();
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(generated.html)[1];
  const ctx = vm.createContext({ window, document: doc, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: { origin, pathname: '/api/auth/vk-oauth/callback', search: '?state=opaque-state&code=private-code&device_id=fixture-device' },
    history: { replaceState: (_a, _b, path) => assert.equal(path, '/api/auth/vk-oauth/callback') },
    sessionStorage: { setItem: (key, value) => stored.set(key, value) },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: !failure, json: async () => failure ? { error: 'replay' } : { type: 'kopilka:vk-oauth', channel, action: 'auth', token: 'fixture-app-token' } }; }
  });
  const pending = vm.runInContext(script, ctx);
  await Promise.resolve();
  return { pending, requests, stored, messages, status, doc, listeners };
}
test('callback bootstrap waits for prerender activation/visibility before explicit POST; preserves exact-origin handoff', async () => {
  const result = await callbackPage({ hidden: true, prerender: true });
  assert.equal(result.requests.length, 0);
  result.doc.prerendering = false; result.listeners.get('prerenderingchange')(); await Promise.resolve();
  assert.equal(result.requests.length, 0);
  result.doc.visibilityState = 'visible'; result.listeners.get('visibilitychange')(); await result.pending;
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, '/api/auth/vk-oauth/complete');
  assert.equal(result.requests[0].options.method, 'POST');
  assert.equal(result.requests[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(result.requests[0].options.body), { state: 'opaque-state', code: 'private-code', device_id: 'fixture-device', error: '' });
  assert.equal(result.messages[0].target, origin); assert.equal(result.messages[0].data.channel, channel);
});
test('callback replay/network rejection cannot overwrite a successful sessionStorage handoff', async () => {
  const result = await callbackPage({ failure: true }); await result.pending;
  assert.equal(result.stored.get('kopilkaVkOAuthHandoff'), 'existing-success');
  assert.equal(result.messages.length, 0); assert.match(result.status.textContent, /попробуйте снова/);
});
