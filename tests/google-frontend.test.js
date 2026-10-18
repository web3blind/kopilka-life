'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client() {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const events = new Map();
  const popup = { closed: false, location: { replace(url) { this.url = url; } }, postMessage(message) { this.ack = message; }, close() { this.closed = true; } };
  const window = { location: { origin: 'https://life.blinddev.xyz', href: 'https://life.blinddev.xyz/', search: '', hash: '' },
    localStorage: {}, open(url) { assert.equal(url, '/api/auth/google/window'); return popup; },
    setInterval() { return 1; }, clearInterval() {},
    addEventListener(type, cb) { events.set(type, cb); } };
  const document = { getElementById: el, querySelectorAll() { return []; }, querySelector() { return null; }, body: {} };
  const ctx = vm.createContext({ window, document, console, URL, URLSearchParams, Intl, Date,
    AbortController, navigator: {}, setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {}, fetch() { throw new Error('unexpected external network'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), ctx);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async () => {\n  fireVkBridgeInit();')), ctx);
  return { ctx, popup, events, el, run: code => vm.runInContext(code, ctx) };
}

test('iframe Google linking opens first-party popup before authenticated API request and accepts only matching handoff', async () => {
  const { ctx, popup, events, run, el } = client();
  let posted = false;
  run(`state.token='vk-session'; state.user={ id: 10 }; api=async (path, options) => {
    if (!state.googleOAuthWindow) throw Error('popup must open synchronously');
    if (path !== '/api/auth/google/start' || options.authToken !== 'vk-session' || JSON.parse(options.body).link !== true) throw Error('invalid link request');
    return { launchUrl: 'https://life.blinddev.xyz/api/auth/google/authorize?intent=opaque', channel: 'ch' };
  }; refreshLinkedLogins=()=>{}; setStatus=()=>{};`);
  await run(`startGoogleOAuth('link')`);
  assert.equal(popup.location.url, 'https://life.blinddev.xyz/api/auth/google/authorize?intent=opaque');
  const listener = events.get('message');
  await listener({ origin: 'https://attacker.example', source: popup, data: { type: 'kopilka:google-oauth', channel: 'ch', linked: true } });
  assert.equal(el('linkGoogleAccount').disabled, false);
  assert.equal(popup.ack, undefined);
  await listener({ origin: 'https://life.blinddev.xyz', source: popup, data: { type: 'kopilka:google-oauth', channel: 'wrong', linked: true } });
  assert.equal(popup.ack, undefined);
  await listener({ origin: 'https://life.blinddev.xyz', source: popup, data: { type: 'kopilka:google-oauth', channel: 'ch', linked: true } });
  assert.equal(popup.ack.channel, 'ch');
  assert.equal(run('state.googleOAuthWindow'), null);
});
