const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/startup.js'), 'utf8');
function harness(seed = 1, crypto = true) {
  let now = 0;
  const logs = [], timers = [], listeners = {}, calls = [];
  const nodes = {};
  const window = {location: {search: '?vk_app_id=fixture&sign=SECRET', hash: '#PRIVATE'},
    localStorage: {getItem() {return null;}}, addEventListener(n,f) {(listeners[n] ||= []).push(f);},
    fetch(url, options) { logs.push({url, options, payload: JSON.parse(options.body)}); return Promise.resolve(); }};
  if (crypto) window.crypto = {getRandomValues(a) {a[0] = seed; a[1] = seed + 1;}};
  const document = {readyState: 'loading', documentElement: {}, getElementById(id) {return nodes[id];},
    addEventListener(n,f) {(listeners[n] ||= []).push(f);}};
  vm.runInNewContext(source, {window, document, Uint32Array, Date: {now: () => now},
    setTimeout(f,ms) {const t = {f,ms,at: now + ms,done: false}; timers.push(t); return t;}, clearTimeout(t) {if (t) t.done = true;}, MutationObserver: class {observe() {}}});
  return {window, document, nodes, logs, timers, calls,
    tick(ms) {now = ms; for (const t of timers.filter(t => !t.done && t.at <= ms)) {t.done = true; t.f();}},
    fire(n,e = {}) {(listeners[n] || []).forEach(f => f(e));},
    native() {window.webkit = {messageHandlers: {VKWebAppInit: {postMessage(p) {calls.push(p);}}, VKWebAppClose: {}}};}};
}
function fields(row) {return Object.fromEntries(row.payload.details.split(';').map(s => s.split('=')));}
function event(h, name) {return h.logs.find(r => r.payload.event === 'startup_' + name);}
test('document-scoped correlation and ordered bounded snapshots fit existing backend details limit', () => {
  const h = harness(), other = harness(5);
  h.window.KopilkaStartup.mark('app-executed');
  h.fire('error', {message: 'SECRET', target: {tagName: 'SCRIPT', src: 'PRIVATE'}});
  assert.notEqual(fields(h.logs[0]).boot, fields(other.logs[0]).boot);
  h.logs.forEach((r,i) => {
    assert.equal(fields(r).seq, String(i + 1));
    assert.ok(r.payload.details.length <= 240);
    assert.equal(r.options.credentials, 'omit'); assert.equal(r.options.referrerPolicy, 'no-referrer');
    assert.equal(r.url, '/api/client-log');
    assert.deepEqual(Object.keys(r.payload), ['event','details','platform','version']);
    assert.ok(!/SECRET|PRIVATE|sign=/.test(r.options.body));
  });
  for (let i=0;i<100;i++) h.window.KopilkaStartup.mark('app-executed');
  assert.equal(h.logs.filter(r => r.payload.event === 'startup_app-executed').length, 1);
  h.window.KopilkaStartup.mark('SECRET'); assert.ok(h.logs.length <= 19);
});
test('late handlers after unhidden DOM remain separate from cached SDK transport and Init result', () => {
  const h = harness();
  h.nodes.startupScreen = {hidden: false}; h.nodes.appShell = {hidden: false}; h.nodes.loginScreen = {hidden: true};
  h.window.vkBridge = {isWebView: () => false, send: () => new Promise(() => {})};
  h.window.KopilkaStartup.mark('bridge-loaded');
  assert.equal(h.calls.length, 0);
  assert.equal(fields(event(h, 'bridge-web')).init, '0');
  assert.equal(fields(event(h, 'ui-visible')).app, 'unhidden');
  h.native(); h.tick(4000);
  const observed = fields(event(h, 'handlers-observed'));
  assert.equal(observed.ms, '4000'); assert.equal(observed.init, '1'); assert.equal(observed.close, '1');
  assert.equal(observed.sdk, 'web'); assert.equal(observed.startup, 'hidden');
  assert.equal(h.calls.length, 1); assert.equal(event(h, 'init-result'), undefined);
  h.fire('VKWebAppEvent', {detail: {type: 'VKWebAppInitResult', data: {token: 'SECRET'}}});
  assert.ok(event(h, 'init-result')); h.tick(8000); assert.equal(h.calls.length, 1);
});
test('readiness and absent roots are not guessed from SDK or handlers', () => {
  const h = harness();
  assert.equal(fields(h.logs[0]).startup, 'absent'); assert.equal(fields(h.logs[0]).ready, 'loading');
  h.native(); h.window.KopilkaStartup.mark('bridge-loaded');
  assert.ok(event(h, 'bridge-unknown')); assert.equal(event(h, 'bridge-web'), undefined);
  assert.equal(h.calls.length, 0);
  h.document.readyState = 'interactive'; h.fire('DOMContentLoaded');
  assert.equal(fields(event(h, 'dom-content-loaded')).ready, 'interactive');
  assert.equal(fields(event(h, 'dom-content-loaded')).app, 'absent');
});
test('maximum diagnostic traffic stays fixed and bounded even after duplicate marks and native events', () => {
  const h = harness(0xffffffff);
  const allowed = source.match(/var allowed = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1,-1));
  h.document.readyState = 'complete';
  h.nodes.startupScreen = {hidden: false}; h.nodes.appShell = {hidden: true}; h.nodes.loginScreen = {hidden: true};
  for (const name of allowed) for (let i=0;i<3;i++) h.window.KopilkaStartup.mark(name);
  assert.equal(h.logs.length, 19); assert.equal(new Set(h.logs.map(r => r.payload.event)).size, 19);
  for (const r of h.logs) {
    assert.ok(r.payload.details.length <= 240);
    assert.equal(fields(r).ready, r.payload.event === 'startup_guard-loaded' ? 'loading' : 'complete');
  }
});
test('native SDK observation and early handlers do not turn into recovery or readiness claims', () => {
  const h = harness(); h.native(); h.window.vkBridge = {isWebView: () => true};
  h.window.KopilkaStartup.mark('bridge-loaded'); h.tick(100);
  assert.equal(h.calls.length, 0);
  assert.equal(fields(event(h, 'handlers-observed')).sdk, 'webview');
  assert.equal(fields(event(h, 'handlers-observed')).app, 'absent');
  assert.equal(event(h, 'init-result'), undefined);
  assert.equal(event(h, 'ui-visible'), undefined);
});
test('missing crypto, throwing diagnostics and unavailable fetch do not interrupt existing recovery', () => {
  const h = harness(1, false); assert.equal(fields(h.logs[0]).boot, 'unavailable');
  h.window.fetch = () => {throw Error('PRIVATE');};
  h.window.vkBridge = {isWebView: () => false, send: () => new Promise(() => {})}; h.native();
  h.tick(100); assert.equal(h.calls.length, 1);
  delete h.window.fetch; h.tick(300); assert.equal(h.calls.length, 1);
});
