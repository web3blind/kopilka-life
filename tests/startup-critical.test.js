const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/startup.js'), 'utf8').trim();
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

// startup.js is the sole authored guard source. The HTML contains an exact
// delivery copy so its recovery path has no network dependency. Run --sync
// after guard edits; the ordinary test enforces byte equality without a build.
const open = '  <!-- STARTUP_GUARD_BEGIN: generated from public/startup.js -->';
const close = '  <!-- STARTUP_GUARD_END -->';
if (process.argv.includes('--sync')) {
  assert(!source.includes('</script'), 'Guard cannot contain a closing script tag');
  const block = open + '\n  <script>\n' + source + '\n  </script>\n' + close;
  const existing = new RegExp(open + '[\\s\\S]*?' + close);
  const next = html.includes(open) ? html.replace(existing, block) : html.replace('  <script src="/startup.js?v=20261006-startup2"></script>', block);
  assert.notEqual(next, html.includes(open) ? '' : html, 'Missing startup insertion point');
  fs.writeFileSync(path.join(root, 'public/index.html'), next);
} else {
  test('HTML embeds the exact canonical guard before secondary resources', () => {
    const match = html.match(/<!-- STARTUP_GUARD_BEGIN[^>]*-->\s*<script>\n([\s\S]*?)\n  <\/script>\s*<!-- STARTUP_GUARD_END -->/);
    assert(match, 'Missing immediate inline guard');
    assert.equal(match[1], source, 'Run node tests/startup-critical.test.js --sync');
    assert(!/<script[^>]+src=["']\/startup\.js/.test(html));
    assert(html.indexOf(open) < html.indexOf('href="/styles.css'));
    new vm.Script(match[1]);
  });
  test('secondary stylesheet does not block initial paint', () => {
    assert.match(html, /<link rel="stylesheet"[^>]*href="\/styles\.css[^>]*media="print"[^>]*onload="this\.media='all'"/);
    assert.match(html, /<noscript><link rel="stylesheet"/);
    assert.match(html, /id="startupReload"[^>]*onclick="window\.location\.reload\(\)"/);
  });
  function guard(search = '?vk_app_id=54723764&sign=private-fixture') {
    const timers = [], calls = [], logs = [], listeners = {};
    const nodes = Object.fromEntries(['startupScreen', 'startupHeading', 'startupMessage', 'startupReload', 'appShell', 'loginScreen'].map(id => [id, {hidden: id === 'appShell' || id === 'loginScreen', textContent: ''}]));
    let now = 0;
    const window = { location: {search, hash: ''}, addEventListener(n, f) {(listeners[n] ||= []).push(f);}, localStorage: {getItem: () => null}, fetch(url, opts) {logs.push(opts); return Promise.resolve();}, vkBridge: {isWebView: () => false, send: () => new Promise(() => {})} };
    const ctx = {window, document: {documentElement: {}, getElementById: id => nodes[id], addEventListener(n, f) {(listeners[n] ||= []).push(f);}}, MutationObserver: class {observe() {}}, setTimeout(f, ms) {const t = {ms, at: now + ms, done: false}; t.f = () => {if (t.done) return; t.done = true; now = Math.max(now, t.at); f();}; timers.push(t); return t;}, clearTimeout(t) {if(t) t.done = true;}, Date: {now: () => now}};
    vm.runInNewContext(source, ctx);
    return {window, nodes, timers, calls, logs,
      tick(end) {for (;;) {const t = timers.filter(t => !t.done && t.at <= end).sort((a,b) => a.at-b.at)[0]; if(!t) break; t.f();} now = end;},
      fire(n, event = {}) { for (const f of listeners[n] || []) f(event); }, native(close = true, throws = false) {window.webkit = {messageHandlers: {VKWebAppInit: {postMessage(p) {calls.push(p); if (throws) throw Error('private');}}, ...(close ? {VKWebAppClose: {}} : {})}};}};
  }
  test('7615529: normal loading hides retry; failures and watchdog reveal localized recovery', () => {
    assert.match(html, /id="startupReload"[^>]*\bhidden\b/);
    assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    assert.match(html, /\.skip-link:focus\s*\{[^}]*clip-path:\s*none/);
    for (const lang of ['ru', 'en']) {
      for (const failure of ['error', 'unhandledrejection', 'watchdog']) {
        const g = guard('?lang=' + lang);
        g.fire('DOMContentLoaded');
        assert.equal(g.nodes.startupReload.hidden, true);
        assert.equal(g.nodes.startupMessage.textContent, lang === 'en' ? 'Loading the app…' : 'Загружаем приложение…');
        if (failure === 'watchdog') g.timers.find(t => t.ms === 10000).f();
        else g.fire(failure, {target: {tagName: 'SCRIPT'}});
        assert.equal(g.nodes.startupReload.hidden, false);
        assert.match(g.nodes.startupMessage.textContent, lang === 'en' ? /could not/ : /Не удалось/);
        g.nodes.loginScreen.hidden = false;
        g.window.KopilkaStartup.mark('app-executed');
        assert.equal(g.nodes.startupScreen.hidden, true);
      }
    }
  });
  test('native readiness continues after visible HTML through 30 seconds, stops thereafter (virtual clock)', async () => {
    for (const arrival of [3500, 9500, 20000]) {
      const g = guard();
      g.nodes.appShell.hidden = false; g.window.KopilkaStartup.mark('app-executed');
      assert(g.nodes.startupScreen.hidden);
      g.tick(arrival); g.native(); g.tick(arrival + 250);
      g.window.KopilkaStartup.mark('bridge-loaded');
      assert.equal(g.calls.length, 1);
      assert.deepEqual(Object.keys(g.calls[0]), ['request_id']);
    }
    const g = guard(); g.tick(30000); await Promise.resolve();
    g.native(); g.tick(31000); g.window.KopilkaStartup.initVkBridge();
    assert.equal(g.calls.length, 0, 'No unbounded polling');
  });
  test('throwing native handler reserves delivery and never retries', () => {
    const g = guard(); g.native(true, true);
    g.window.KopilkaStartup.mark('bridge-loaded');
    assert.equal(g.calls.length, 1);
    g.native(); g.tick(31000);
    g.window.KopilkaStartup.mark('bridge-loaded');
    assert.equal(g.calls.length, 1);
  });
  test('native guard retains launch, Init+Close and cached-web-transport conditions', () => {
    for (const mode of ['website', 'missingClose', 'nativeSDK', 'noSDK']) {
      const g = guard(mode === 'website' ? '' : undefined); g.native(mode !== 'missingClose');
      if (mode === 'nativeSDK') g.window.vkBridge.isWebView = () => true;
      if (mode === 'noSDK') delete g.window.vkBridge;
      for (const t of g.timers) t.f();
      assert.equal(g.calls.length, 0, mode);
    }
  });
  test('startup diagnostics remain credentialless and fixed-field after native failure', () => {
    const g = guard(); g.native(true, true);
    for (const t of g.timers) t.f();
    for (const opts of g.logs) {
      assert.equal(opts.credentials, 'omit'); assert.equal(opts.referrerPolicy, 'no-referrer');
      const payload = JSON.parse(opts.body);
      assert.match(payload.details, /^boot=(?:[a-f0-9]{1,8}-[a-f0-9]{1,8}|unavailable);seq=(?:[1-9]|1[0-9]);ms=\d{1,5};ready=(?:loading|interactive|complete|unknown);startup=(?:absent|hidden|unhidden);app=(?:absent|hidden|unhidden);login=(?:absent|hidden|unhidden);init=[01];close=[01];sdk=(?:unknown|webview|web)$/);
      assert.ok(payload.details.length <= 240);
      assert(!/https?:|sign=|user_id|token|Bearer|private/i.test(opts.body));
      assert.deepEqual(Object.keys(payload), ['event', 'details', 'platform', 'version']);
    }
  });
}
