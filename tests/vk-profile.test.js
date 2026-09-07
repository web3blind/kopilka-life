const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Do not load config.js/dotenv or touch any application database/credentials.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-vk-profile-'));
const configPath = require.resolve('../src/config');
const config = {
  nodeEnv: 'test', isProduction: false, dbPath: path.join(tempDir, 'test.sqlite'),
  vkAppId: '123', vkSecureKey: 'fixture-signing-key', vkAuthMaxAgeSeconds: 600,
  vkGroupToken: 'fixture-group-token', sessionSecret: 'fixture-session-secret', sessionMaxAgeSeconds: 600,
  vkOAuthClientId: '123', vkOAuthAuthorizeUrl: 'https://id.vk.ru/authorize',
  vkOAuthTokenUrl: 'https://id.vk.ru/oauth2/auth', webappUrl: 'https://fixture.invalid',
  rateLimits: { storyWindowMs: 60000, storyMax: 200, authWindowMs: 60000, authMax: 200, devWindowMs: 60000, devMax: 200 }
};
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: config };
const originalFetch = global.fetch;
let provider;
let profileCalls = [];
global.fetch = async (url, options) => {
  // Every fetch is fake, including the OAuth code exchange. Unknown traffic fails closed.
  if (url === config.vkOAuthTokenUrl) return { ok: true, json: async () => ({ user_id: '200000907294' }) };
  assert.equal(url, 'https://api.vk.com/method/users.get');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(options.body.get('access_token'), config.vkGroupToken);
  assert.equal(options.body.get('v'), '5.199');
  assert(options.signal instanceof AbortSignal);
  profileCalls.push(options.body.get('user_ids'));
  return provider(options);
};
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/usersService');
const { verifyToken } = require('../src/auth/session');
const oauth = require('../src/auth/vkOAuth');
const router = require('../src/routes/api');
const vkId = '200000907294';
const ok = (firstName = 'Лада', id = vkId) => async () => ({ ok: true, json: async () => ({ response: [{ id, first_name: firstName }] }) });
function launch(id = vkId) {
  const params = new URLSearchParams({ vk_app_id: '123', vk_ts: String(Math.floor(Date.now() / 1000)), vk_user_id: id });
  const signed = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  params.set('sign', crypto.createHmac('sha256', config.vkSecureKey).update(signed).digest('base64url'));
  return params.toString();
}
async function invoke(routePath, { body = {}, query = {}, cookie = '' } = {}) {
  const route = router.stack.find((layer) => layer.route?.path === routePath).route;
  const res = {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; }, send(data) { this.data = data; return this; },
    set() { return this; }, append() { return this; }, type() { return this; }
  };
  await route.stack.at(-1).handle({ body, query, get: (key) => key === 'cookie' ? cookie : '' }, res);
  return res;
}
const login = (extra = {}, id = vkId) => invoke('/auth/vk', { body: { launchParams: launch(id), ...extra } });
async function oauthLogin(action = 'auth', userId = null) {
  const binding = 'a'.repeat(48);
  const { intent } = oauth.createOAuthIntent({ action, userId });
  const state = new URL(oauth.beginOAuthIntent(intent, binding)).searchParams.get('state');
  return invoke('/auth/vk-oauth/callback', {
    query: { state, code: 'fixture-code', device_id: 'fixture-device', user_id: '999', first_name: 'Spoof' },
    cookie: `kopilka_oauth_browser=${binding}`
  });
}
async function main() {
  const db = getDb();
  provider = ok();
  const inviter = users.upsertTelegramUser({ id: 800, first_name: 'Пригласивший' });
  let res = await login({ first_name: 'Spoof', firstName: 'Spoof', id: '999', vkId: '999', user: { id: '999', first_name: 'Spoof' }, refCode: inviter.ref_code });
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.user.firstName, 'Лада', 'new signed VK user gets server profile, not placeholder/client name');
  const initial = users.getUserById(res.data.user.id);
  assert.equal(initial.vk_id, vkId);
  assert.equal(initial.referrer_id, inviter.id);
  assert.equal(verifyToken(res.data.token), initial.id);
  assert.deepEqual(profileCalls, [vkId]);
  console.log('PASS new signed login: verified identity/name, spoof ignored, referral');

  db.prepare("UPDATE users SET first_name = 'VK user' WHERE id = ?").run(initial.id);
  db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'history fixture', 2, '2026-09-01')").run(initial.id);
  const history = db.prepare('SELECT * FROM entries WHERE user_id = ?').all(initial.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res = await login();
  assert.equal(res.data.user.firstName, 'Лада');
  let updated = users.getUserById(initial.id);
  assert.equal(updated.id, initial.id);
  assert.equal(updated.ref_code, initial.ref_code);
  assert.equal(updated.referrer_id, initial.referrer_id);
  assert.equal(updated.telegram_id, initial.telegram_id);
  assert.deepEqual(db.prepare('SELECT * FROM entries WHERE user_id = ?').all(initial.id), history);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, count);
  provider = ok('Новое имя');
  assert.equal((await login()).data.user.firstName, 'Новое имя', 'refresh non-placeholder VK-only names too');
  console.log('PASS existing placeholder/name refresh: id/history/referral code retained');

  const failures = [
    ['HTTP failure', async () => ({ ok: false, json: async () => { throw Error('must not parse'); } })],
    ['VK error', async () => ({ ok: true, json: async () => ({ error: { error_code: 5 }, response: [{ id: vkId, first_name: 'Bad' }] }) })],
    ['mismatched identity', ok('Bad', '999')], ['blank name', ok(' \n\u0000\u200b ')],
    ['wrong name type', ok({ name: 'Bad' })], ['missing response', async () => ({ ok: true, json: async () => ({}) })],
    ['null JSON', async () => ({ ok: true, json: async () => null })],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw Error('JSON fixture'); } })],
    ['network error', async () => { throw Error('network fixture'); }]
  ];
  for (const [label, fake] of failures) {
    provider = fake;
    const before = profileCalls.length;
    res = await login({ first_name: 'Spoof' });
    assert.equal(res.statusCode, 200, label);
    assert.equal(res.data.user.firstName, 'Новое имя', label);
    assert.equal(verifyToken(res.data.token), initial.id, label);
    assert.equal(profileCalls.length, before + 1, 'no retries');
  }
  config.vkGroupToken = '';
  const beforeMissing = profileCalls.length;
  assert.equal((await login()).data.user.firstName, 'Новое имя');
  assert.equal(profileCalls.length, beforeMissing, 'missing token skips fetch');
  config.vkGroupToken = 'fixture-group-token';
  provider = async () => { throw Error('offline'); };
  res = await login({ first_name: 'Spoof' }, '222');
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.user.firstName, 'VK user', 'new user can log in without profile');
  console.log('PASS HTTP/API/identity/blank/JSON/network/missing-token fail-open, no retries');

  // Actual production timeout, with a stalled fake response body: no real network.
  provider = ({ signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const keepAlive = setInterval(() => {}, 100);
  const started = performance.now();
  try { res = await login(); } finally { clearInterval(keepAlive); }
  const elapsed = performance.now() - started;
  assert(elapsed >= 2500 && elapsed < 4500, `bounded timeout: ${elapsed}ms`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.user.firstName, 'Новое имя');
  console.log('PASS ~3s timeout includes response body and preserves login');

  provider = ok(' \u202eЛада\u0000\n <>' + 'я'.repeat(100));
  res = await login();
  assert.equal(res.data.user.firstName.length, 60);
  assert.match(res.data.user.firstName, /^Лада /);
  assert(!/[\p{Cc}\p{Cf}<>]/u.test(res.data.user.firstName));
  const linked = users.upsertTelegramUser({ id: 801, first_name: 'Телеграм-имя' });
  users.linkVkUser(linked.id, '333');
  provider = ok('VK-имя', '333');
  res = await login({}, '333');
  assert.equal(res.data.user.id, linked.id);
  assert.equal(res.data.user.firstName, 'Телеграм-имя');
  console.log('PASS bounded sanitized names; linked Telegram name preserved');

  const oldError = console.error;
  const beforeInvalid = profileCalls.length;
  console.error = () => {};
  try { res = await login({ launchParams: launch().replace(/sign=[^&]+/, 'sign=invalid'), first_name: 'Spoof' }); }
  finally { console.error = oldError; }
  assert.equal(res.statusCode, 401);
  assert.equal(profileCalls.length, beforeInvalid, 'invalid signature never queries profile');
  console.log('PASS invalid signature rejected before lookup');

  provider = ok('Имя OAuth');
  res = await oauthLogin();
  assert.match(res.data, /"action":"auth","token":/);
  assert.equal(users.getUserById(initial.id).first_name, 'Имя OAuth');
  assert.equal(profileCalls.at(-1), vkId, 'OAuth uses token-exchange identity, not callback query');
  provider = async () => { throw Error('offline'); };
  res = await oauthLogin();
  assert.match(res.data, /"action":"auth","token":/);
  assert.equal(users.getUserById(initial.id).first_name, 'Имя OAuth');
  const beforeLink = profileCalls.length;
  res = await oauthLogin('link', linked.id);
  assert.match(res.data, /"action":"link","linkProof":/);
  assert.equal(profileCalls.length, beforeLink, 'link flow unchanged, no profile write');
  assert.deepEqual(db.prepare('SELECT * FROM entries WHERE user_id = ?').all(initial.id), history);
  assert.equal(users.getUserById(initial.id).ref_code, initial.ref_code);
  console.log('PASS OAuth auth refresh/failure and unchanged link-proof flow');
  console.log('VK profile tests passed (7 groups; fake fetch only, temporary SQLite)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
