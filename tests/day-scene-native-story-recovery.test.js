const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute production event handler and global busy lifecycle; no server, dotenv,
// database, browser, credentials or network. Only the native SDK is substituted.
const app = fs.readFileSync('public/app.js', 'utf8');
const scene = fs.readFileSync('public/day-scene.js', 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function harness() {
  let handler, calls = 0, native = deferred();
  const attrs = {};
  const button = { id: 'daySceneShare', dataset: {}, disabled: false,
    addEventListener: (_, fn) => { handler = fn; },
    getAttribute: key => attrs[key] ?? null,
    setAttribute: (key, value) => { attrs[key] = value; } };
  const statuses = [];
  const context = { state: { busy: false, publicReadOnly: false },
    document: { querySelectorAll: () => [button], body: { setAttribute() {} } },
    $: () => button, telegramDayStorySupported: () => false, isVkMiniApp: () => true,
    locale: () => 'ru', daySceneDate: () => 'fixture-date', L: key => key,
    setStatus: (text, type) => statuses.push({ text, type }), applyStaticI18n() {},
    window: { KopilkaDayScene: { share: () => { calls++; return native.promise; } } } };
  const start = app.indexOf("  $('daySceneShare')?.addEventListener('click',");
  const end = app.indexOf("  $('gratitudePractice')", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(app.slice(app.indexOf('const busyDisabled ='), app.indexOf('async function withBusy(')) +
    app.slice(start, end) + '\nglobalThis.qaBusy = setBusy;', context);
  return { button, statuses, native, calls: () => calls,
    click: () => handler({ currentTarget: button }), busy: value => context.qaBusy(value),
    retry: () => { native = deferred(); return native; } };
}
for (const order of ['story-first', 'refresh-first']) {
  for (const outcome of ['cancelled', 'story_editor', 'rejection', 'timeout']) {
    test(`day story recovers after ${outcome}, ${order} return refresh`, async () => {
      const h = harness();
      const pending = h.click();
      assert.equal(h.button.disabled, true);
      await h.click(); assert.equal(h.calls(), 1);
      h.busy(true); // Native return triggers foreground refresh while SDK is pending.
      if (order === 'refresh-first') {
        h.busy(false);
        assert.equal(h.button.disabled, true, 'refresh must not unlock a pending editor');
        await h.click(); assert.equal(h.calls(), 1);
      }
      if (outcome === 'rejection' || outcome === 'timeout') h.native.reject(new Error(outcome));
      else h.native.resolve(outcome);
      await pending;
      const disabledWhileBusy = h.button.disabled;
      if (order === 'story-first') h.busy(false);
      assert.equal(h.button.disabled, false, 'return refresh must not restore stale disabled=true');
      if (order === 'story-first') assert.equal(disabledWhileBusy, true, 'story finally must preserve global busy');
      if (outcome === 'cancelled') assert.equal(h.statuses.at(-1).text, 'daySceneStoryCanceled');
      if (outcome === 'rejection' || outcome === 'timeout') assert.deepEqual(h.statuses.at(-1), { text: 'daySceneStoryError', type: 'error' });
      const retry = h.retry();
      const second = h.click(); assert.equal(h.calls(), 2, 'second tap reopens story');
      retry.resolve('cancelled'); await second;
      assert.equal(h.button.disabled, false);
    });
  }
}

for (const [platform, existing, expected] of [
  ['mobile_android', '', '64px'], ['mobile_android', '28px', '64px'],
  ['mobile_android', '92px', '92px'], ['desktop_web', '28px', '28px'],
  ['', '', ''], ['mobile_iphone', '', '']
]) test(`VK status top minimum only on ${platform || 'website'} (${existing || 'unset'})`, () => {
  let value = existing;
  const root = { style: { setProperty: (key, next) => { assert.equal(key, '--vk-status-top'); value = next; } } };
  const start = app.indexOf('function applyVkStatusTop()');
  assert.ok(start >= 0, 'Android-only status top initializer exists');
  const end = app.indexOf('function fireVkBridgeInit()', start);
  const scope = { URLSearchParams, vkLaunchParams: () => '', document: { documentElement: root },
    window: { location: { search: platform ? `?vk_platform=${platform}` : '' },
      getComputedStyle: () => ({ getPropertyValue: () => existing }) } };
  vm.runInNewContext(app.slice(start, end) + '\napplyVkStatusTop();', scope);
  assert.equal(value, expected);
});

// Execute the actual canvas-export/SDK adapter with deterministic canvas/images.
function engine(send) {
  const drawing = { fillRect() {}, fillText() {}, drawImage() {} };
  const window = { KopilkaI18n: { t: () => 'fixture' }, vkBridge: { send } };
  const context = { window, document: { createElement: () => ({ getContext: () => drawing,
    toDataURL: () => 'data:image/png;base64,QA' }) },
    Image: class { set src(_) { this.onload(); } }, setTimeout, clearTimeout };
  vm.runInNewContext(scene, context);
  return window.KopilkaDayScene;
}
test('native User denied is cancellation, SDK false and other rejection are not publication', async () => {
  assert.equal(await engine(() => Promise.reject({ error_data: { error_reason: 'User denied' } })).share('ru', 'date', 'vk'), 'cancelled');
  await assert.rejects(engine(() => Promise.resolve({ result: false })).share('ru', 'date', 'vk'), /editor unavailable/);
  await assert.rejects(engine(() => Promise.reject(new Error('native failed'))).share('ru', 'date', 'vk'), /native failed/);
  const timeout = Object.assign(new Error('native callback timed out'), { code: 'NATIVE_TIMEOUT' });
  await assert.rejects(engine(() => Promise.reject(timeout)).share('ru', 'date', 'vk'), error => error === timeout,
    'timeout rejection is propagated, never recast as SDK false or user cancellation');
  assert.equal(await engine(() => Promise.resolve({ result: true })).share('ru', 'date', 'vk'), 'story_editor', 'SDK success only means editor handoff, not published');
});
