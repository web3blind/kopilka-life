const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/startup.js'), 'utf8');
const vendor = fs.readFileSync(path.join(root, 'public/vendor/vk-bridge-3.0.2.min.js'), 'utf8');
const app = fs.readFileSync(process.env.KOPILKA_NATIVE_APP_SOURCE || path.join(root, 'public/app.js'), 'utf8');
const fireStart = app.includes('let vkBridgeInitFallback;') ? app.indexOf('let vkBridgeInitFallback;') : app.indexOf('function fireVkBridgeInit()');
const fire = app.slice(fireStart, app.indexOf('function clientLogDetails'));
const init = app.slice(app.indexOf('async function initVkBridge()'), app.indexOf('function safeFirstPartyOAuthUrl'));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture({search = '?vk_app_id=54723764', cached = null, native = false, startup = true} = {}) {
  let now = 0;
  const timers = [], calls = [], packets = [], logs = [], events = {};
  const nodes = Object.fromEntries(['startupScreen', 'startupHeading', 'startupMessage', 'startupReload', 'appShell', 'loginScreen'].map(id => [id, {hidden: ['appShell', 'loginScreen'].includes(id), textContent: ''}]));
  const window = {location: {search, hash: ''}, navigator: {userAgent: ''}, localStorage: {getItem: () => cached},
    addEventListener(n, f) {(events[n] ||= []).push(f);}, parent: {postMessage(p) {packets.push(p);}},
    fetch(u, o) {logs.push(o); return Promise.resolve();}};
  if (native) window.webkit = {messageHandlers: {VKWebAppClose: {}}};
  const ctx = vm.createContext({window, location: window.location, navigator: window.navigator, parent: window.parent,
    document: {documentElement: {}, getElementById: id => nodes[id], addEventListener(n, f) {(events[n] ||= []).push(f);}},
    URLSearchParams, Promise, Set, Date: class extends Date {static now() {return now;}},
    setTimeout(f, delay) {const t = {f, at: now + delay}; timers.push(t); return t;},
    clearTimeout(t) {const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1);}});
  if (startup) vm.runInContext(source, ctx);
  vm.runInContext(vendor, ctx);
  let sends = 0;
  const send = window.vkBridge.send;
  window.vkBridge.send = (...args) => {sends++; return send(...args);};
  return {window, ctx, nodes, timers, calls, packets, logs, sends: () => sends,
    ready(behavior = 'pending') {window.webkit ||= {messageHandlers: {VKWebAppClose: {}}}; window.webkit.messageHandlers.VKWebAppInit = {postMessage(p) {
      calls.push(p);
      if (behavior === 'reentrant') window.KopilkaStartup.initVkBridge();
      if (behavior === 'throw') throw Error('private native exception');
    }};},
    async tick(end) {await flush(); for (;;) {timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.f(); await flush();} now = end; await flush();},
    event(n) {for (const f of events[n] || []) f({});},
    app() {ctx.applyVkStatusTop = () => {}; ctx.vkLaunchParams = () => search; vm.runInContext(fire + '\n' + init, ctx);},
  };
}
test('late 8500ms live handlers dispatch without another bridge-loaded event, even after UI appears', async () => {
  const f = fixture(); f.window.KopilkaStartup.mark('bridge-loaded');
  f.nodes.appShell.hidden = false; f.window.KopilkaStartup.mark('app-executed');
  assert.equal(f.nodes.startupScreen.hidden, true);
  await f.tick(8500); f.ready(); await f.tick(9000);
  assert.equal(f.calls.length, 1);
  await f.tick(31000); assert.equal(f.timers.length, 0);
});
test('ambiguous throwing native invocation stays reserved across timers and events', async () => {
  const f = fixture(); f.ready('throw'); f.window.KopilkaStartup.mark('bridge-loaded');
  await f.tick(31000); f.window.KopilkaStartup.mark('bridge-loaded');
  assert.equal(f.calls.length, 1);
});
test('actual app bootstrap plus auth path reuse one SDK request and one parent web packet', async () => {
  const f = fixture(); f.app();
  vm.runInContext('fireVkBridgeInit(); initVkBridge();', f.ctx);
  await f.tick(1600);
  assert.equal(f.sends(), 1);
  assert.equal(f.packets.filter(p => p.handler === 'VKWebAppInit').length, 1);
});
test('reentrant direct fallback cannot invoke the host twice', async () => {
  const f = fixture(); f.ready('reentrant'); f.window.KopilkaStartup.mark('bridge-loaded');
  await f.tick(31000); assert.equal(f.calls.length, 1);
});
test('locale precedence remains explicit, cache, VK hint, RU default (presentation only)', () => {
  for (const [search, cached, expected] of [['?lang=ru&vk_language=en', 'en', 'ru'], ['?lang=en', 'ru', 'en'], ['?vk_language=ru', 'en', 'en'], ['?vk_language=en', null, 'en'], ['', null, 'ru']]) {
    const f = fixture({search, cached}); assert.equal(f.window.KopilkaStartup.locale(), expected);
    f.event('DOMContentLoaded'); assert.equal(f.nodes.startupMessage.textContent, expected === 'en' ? 'Loading the app…' : 'Загружаем приложение…');
  }
});
test('absent guard fallback reserves the SDK request before throw or reentry', async () => {
  for (const behavior of ['pending', 'reject', 'throw', 'reentrant']) {
    const f = fixture({startup: false}); f.app(); let count = 0;
    f.window.vkBridge.send = () => {
      count++;
      if (behavior === 'throw') throw Error('private');
      if (behavior === 'reject') return Promise.reject(Error('private'));
      if (behavior === 'reentrant') vm.runInContext('fireVkBridgeInit()', f.ctx);
      return new Promise(() => {});
    };
    vm.runInContext('fireVkBridgeInit(); fireVkBridgeInit(); initVkBridge();', f.ctx);
    await f.tick(1600); assert.equal(count, 1, behavior); assert.equal(f.packets.length, 0);
  }
});
test('absent guard parent fallback is once and only on explicit SDK web classification', async () => {
  for (const classification of [false, true, undefined]) {
    const f = fixture({startup: false}); f.app();
    f.window.vkBridge = {isWebView: () => classification};
    vm.runInContext('fireVkBridgeInit(); fireVkBridgeInit(); initVkBridge();', f.ctx);
    await f.tick(1600); assert.equal(f.packets.length, classification === false ? 1 : 0);
  }
});
test('app non-VK startup never sends initialization or parent packets', async () => {
  for (const hasGuard of [false, true]) {
    const f = fixture({search: ''}); if (!hasGuard) delete f.window.KopilkaStartup; f.app();
    vm.runInContext('fireVkBridgeInit(); initVkBridge();', f.ctx);
    await f.tick(31000); assert.equal(f.sends(), 0); assert.equal(f.packets.length, 0);
  }
});
test('no SDK never invokes live native handler; late SDK after expiry cannot revive', async () => {
  const f = fixture(); delete f.window.vkBridge; f.ready();
  await f.tick(31000); vm.runInContext(vendor, f.ctx); f.window.KopilkaStartup.mark('bridge-loaded');
  await f.tick(60000); assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
});
test('native SDK rejected Init promise is still a consumed native attempt', async () => {
  const f = fixture({native: true}); f.ready(); let sends = 0;
  f.window.vkBridge.send = () => {sends++; return Promise.reject(Error('private rejection'));};
  f.window.KopilkaStartup.mark('bridge-loaded'); await f.tick(31000);
  f.window.KopilkaStartup.initVkBridge(); await flush(); assert.equal(sends, 1);
});
test('fixed-field startup telemetry survives the current client-log handler without private fields', async () => {
  const f = fixture({native: true}); f.ready('throw');
  f.window.KopilkaStartup.mark('bridge-loaded'); await f.tick(31000);
  const api = fs.readFileSync(path.join(root, 'src/routes/api.js'), 'utf8');
  const compact = api.slice(api.indexOf('function compactClientLog('), api.indexOf('function vkLaunchDiag('));
  const routeStart = api.indexOf("router.post('/client-log',");
  const route = api.slice(routeStart, api.indexOf('\n});', routeStart) + 4);
  let handler; const lines = [];
  vm.runInNewContext(compact + '\n' + route, {router: {post(p, f) {assert.equal(p, '/client-log'); handler = f;}}, console: {log(s) {lines.push(s);}}});
  let seq = 0;
  for (const options of f.logs) {
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload), ['event', 'details', 'platform', 'version']);
    assert.match(payload.details, /^boot=(?:[a-f0-9]{1,8}-[a-f0-9]{1,8}|unavailable);seq=\d{1,2};ms=\d{1,5};ready=(?:loading|interactive|complete|unknown);startup=(?:absent|hidden|unhidden);app=(?:absent|hidden|unhidden);login=(?:absent|hidden|unhidden);init=[01];close=[01];sdk=(?:unknown|webview|web)$/);
    assert.equal(Number(payload.details.match(/;seq=(\d+);/)[1]), ++seq);
    assert(payload.details.length <= 240); assert(!/https?:|sign=|user_id|token|private|exception/i.test(options.body));
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    let response; handler({body: payload}, {json(value) {response = value;}});
    assert.equal(response.ok, true); assert(lines.at(-1).endsWith('details=' + payload.details));
  }
  assert(seq > 0);
});
test('unsettled supportsAsync cannot leave readiness checks or dispatch after deadline', async () => {
  const f = fixture({native: true}); let release;
  f.window.vkBridge.supportsAsync = () => new Promise(r => {release = r;});
  f.window.KopilkaStartup.mark('bridge-loaded'); await f.tick(30000);
  let settled = false; f.window.KopilkaStartup.initVkBridge().then(() => {settled = true;});
  await flush(); assert.equal(settled, true); assert.equal(f.timers.length, 0);
  f.ready(); release(true); await f.tick(60000); assert.equal(f.calls.length, 0);
});
