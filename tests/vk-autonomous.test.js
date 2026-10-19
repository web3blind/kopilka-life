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
test('neutral popup clears name and never reads credentials, creates intent or navigates', () => {
  const generated = buildOAuthWindowDocument();
  const window = { name: 'untrusted old context' };
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(generated.html)[1];
  vm.runInNewContext(script, {window});
  assert.equal(window.name, '');
  assert.match(generated.csp, /connect-src 'none'/);
  assert(!generated.html.includes('/api/auth/vk-oauth/intent'));
});
function client() {
  const stored = new Map(), elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  let snapshot;
  const popup = { closed: false, location: { replace() {} }, postMessage() {}, close() { this.closed = true; } };
  const window = { location: { origin, href: origin + '/', search: '', hash: '' }, localStorage: {},
    open(url, name) { assert.equal(url, '/api/auth/vk-oauth/window'); snapshot = name; return popup; },
    setInterval() { return 1; }, clearInterval() {}, addEventListener() {} };
  const ctx = vm.createContext({ window, document: { getElementById: el, createElement: () => ({}), querySelectorAll: () => [], querySelector: () => null, body: {} }, console, URL, URLSearchParams, Intl, Date, crypto: crypto.webcrypto,
    sessionStorage: { setItem: (k, v) => stored.set(k, v), getItem: k => stored.get(k), removeItem: k => stored.delete(k) },
    navigator: {}, AbortController, setTimeout, clearTimeout, fetch() { throw Error('opener must not fetch'); } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/i18n.js'), 'utf8'), ctx);
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async () => {\n  fireVkBridgeInit();')), ctx);
  return { ctx, window, stored, popup, el, snapshot: () => snapshot, run: code => vm.runInContext(code, ctx) };
}
test('opener bootstraps synchronously, removes secrets, and rejects source/origin/channel/action mismatches', async () => {
  const c = client();
  c.ctx.locationOrigin=origin;
  c.run("state.token='original-session'; captureRefCode=()=> 'REF'; detectTimezone=()=> 'UTC'; getPublicConfig=async()=>({vkOAuthEnabled:true});api=async(path,opts)=>({channel:JSON.parse(opts.body).channel,launchUrl:locationOrigin+'/api/auth/vk-oauth/start?intent='+'i'.repeat(32)});");
  await c.run("startVkOAuth('link')");
  assert.equal(c.snapshot(), '_blank');
  assert.equal(c.run('state.vkOAuthAction'), 'link');
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
