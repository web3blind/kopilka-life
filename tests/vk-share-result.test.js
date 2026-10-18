'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('public/app.js', 'utf8');
// Execute the actual scoped share functions, without booting unrelated app UI.
const start = app.indexOf('  function vkShareResultStatus(');
const end = app.indexOf('  const shareRefBtn', start);
function fixture(result, error, extra = {}) {
  const calls = [], statuses = [], manual = [];
  const c = { vkSharePending: new Set(), vkShareRequestId: 0, vkShareReturnUntil: 0, window: { vkBridge: { send: async method => {
    calls.push(method); if (error) throw error; return result;
  }}}, navigator: {}, $: () => ({}), isVkMiniApp: () => true,
  L: key => key, setStatus: (...args) => statuses.push(args),
  showManualShare: (...args) => manual.push(args), clientLog: () => {},
  userSafeErrorMessage: () => 'fixture failure', copyText: async () => { calls.push('copy'); return true; }, ...extra };
  vm.createContext(c); vm.runInContext(app.slice(start, end), c);
  return { c, calls, statuses, manual };
}
const cases = [
  ['message-array', [{ type: 'message', users: [{ id: 1 }] }], 'shareCompleted'],
  ['message-single', { type: 'message', users: [{ id: 1 }] }, 'shareCompleted'],
  ['message-sdk-spread', { 0: { type: 'message', users: [{ id: 1 }] } }, 'shareCompleted'],
  ['message-vk-native-items-envelope', { items: [{ type: 'message', users: [{ id: 1 }] }] }, 'shareCompleted'],
  ['empty-vk-native-items-envelope', { items: [] }, 'shareUnconfirmed'],
  ['story-single', { type: 'story', story_id: 'fixture-story' }, 'sharePublicationCompleted'],
  ['story-vk-native-items-envelope', { items: [{ type: 'story', story_id: 'fixture-story' }] }, 'sharePublicationCompleted'],
  ['post-array', [{ type: 'post', post_id: 'fixture-post' }], 'sharePublicationCompleted'],
  ['post-sdk-spread', { 0: { type: 'post', post_id: 'fixture-post' } }, 'sharePublicationCompleted'],
  ['mixed-publication', [{ type: 'message', users: [{ id: 1 }] }, { type: 'story', story_id: 's' }], 'sharePublicationCompleted'],
  ['legacy', { result: true }, 'shareActionCompleted'],
  ...[null, undefined, false, true, [], {}, { result: false }, { result: 'true' },
    { type: 'message', users: [] }, { type: 'message', users: {} },
    { type: 'story', story_id: '' }, { type: 'story', story_id: ' ' }, { type: 'post', post_id: 123 },
    { type: 'qr' }, { type: 'link', result: true }, { type: 'other' }, { type: 'unknown', users: [1] },
    { data: { type: 'message', users: [1] } }, { foo: { type: 'post', post_id: 'p' } },
    { '01': { type: 'post', post_id: 'p' } }, { 0: null }, { 0: { type: 'message', users: [] } }
  ].map((v, i) => [`neutral-${i}`, v, 'shareUnconfirmed'])
];
for (const [name, value, expected] of cases) test(name, async () => {
  const f = fixture(value);
  assert.equal(f.c.vkShareResultStatus(value), expected);
  await f.c.shareUrl('https://example.invalid/fixture', 'fixture');
  assert.deepEqual(f.calls, ['VKWebAppShare']);
  if (expected === 'shareUnconfirmed') {
    assert.deepEqual(f.statuses, []);
    assert.deepEqual(f.manual, [['https://example.invalid/fixture', expected, 'info']]);
  } else assert.deepEqual(f.statuses, [[expected]]);
});
test('explicit cancellation returns without clipboard/native/Telegram fallback', async () => {
  const f = fixture(null, { error_type: 'client_error', error_data: { error_code: 4 } });
  f.c.navigator.share = async () => f.calls.push('native-share');
  f.c.window.Telegram = { WebApp: { initData: 'fixture', switchInlineQuery: () => f.calls.push('telegram'), openTelegramLink: () => f.calls.push('telegram-link') } };
  await f.c.shareUrl('https://example.invalid/fixture', 'fixture');
  assert.deepEqual(f.calls, ['VKWebAppShare']);
  assert.deepEqual(f.statuses, [['shareCancelled']]);
  assert.deepEqual(f.manual, []);
  assert.equal(f.c.vkSharePending.size, 0);
  assert.ok(f.c.vkShareReturnUntil > Date.now());
});
for (const error of [
  { error_type: 'client_error', error_data: { error_code: 5 } },
  { error_type: 'api_error', error_data: { error_code: 4 } },
  { error_data: { error_code: 4 } },
  { error_type: 'client_error', error_data: { error_code: '4' } }
]) test(`genuine/non-cancel failure keeps copy fallback ${JSON.stringify(error)}`, async () => {
  const f = fixture(null, error);
  await f.c.shareUrl('https://example.invalid/fixture', 'fixture');
  assert.deepEqual(f.calls, ['VKWebAppShare', 'copy']);
  assert.deepEqual(f.statuses, [['copied', 'info', 'copy']]);
});
test('failed copy keeps manual fallback and makes no success claim', async () => {
  const f = fixture(null, { error_type: 'client_error', error_data: { error_code: 5 } }, { copyText: async () => false });
  await f.c.shareUrl('https://example.invalid/fixture', 'fixture');
  assert.deepEqual(f.statuses, []);
  assert.deepEqual(f.manual, [['https://example.invalid/fixture', 'copyFailed']]);
});
for (const locale of ['ru', 'en']) test(`status strings translated ${locale}`, () => {
  const c = { window: {} }; vm.runInNewContext(fs.readFileSync('public/i18n.js', 'utf8'), c);
  for (const key of ['shareCompleted', 'sharePublicationCompleted', 'shareActionCompleted', 'shareUnconfirmed', 'shareCancelled']) {
    const text = c.window.KopilkaI18n.t(locale, key);
    assert.ok(text && text !== key);
  }
});
