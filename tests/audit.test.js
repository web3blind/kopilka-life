const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `kopilka-life-audit-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_ENABLED = 'true';
process.env.SCHEDULER_ENABLED = 'false';
process.env.BOT_TOKEN = 'audit-test-bot-token';
process.env.BOT_USERNAME = 'HarborLifeBot';
process.env.WEBAPP_URL = 'https://life.blinddev.xyz';
process.env.APP_BASE_URL = 'https://life.blinddev.xyz';
process.env.SESSION_SECRET = 'audit-test-session-secret';
process.env.SESSION_MAX_AGE_SECONDS = '3600';
process.env.VK_APP_ID = '54723764';
process.env.VK_OAUTH_CLIENT_ID = '54723764';
process.env.VK_OAUTH_CLIENT_SECRET = 'audit-test-vk-oauth-secret';
process.env.VK_SECURE_KEY = 'audit-test-vk-secure-key';
process.env.TELEGRAM_WEBHOOK_SECRET = 'audit_test_webhook_secret';
process.env.RATE_LIMIT_API_MAX = '1000';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_WEBHOOK_MAX = '1000';

const { createApp } = require('../src/server');
const config = require('../src/config');
const { validateRuntimeConfig } = config;
const { closeDb, getDb } = require('../src/db');
const { createToken, inspectToken } = require('../src/auth/session');
const { createOAuthIntent, beginOAuthIntent, consumeState, exchangeCode, createOAuthLinkProof, consumeOAuthLinkProof, buildOAuthHandoffDocument } = require('../src/auth/vkOAuth');
const { createDemoUser } = require('../src/services/usersService');
const { callTelegram, buildInlineQueryResults, TELEGRAM_OUTBOUND_TIMEOUT_MS } = require('../src/telegram');
const { claimUpdate, markUpdateDone, markUpdateFailed, PROCESSING_LEASE_MS } = require('../src/services/telegramUpdatesService');
const { todayForUser } = require('../src/services/entriesService');
const { parseMode, buildSetWebhookPayload } = require('../scripts/set-webhook');

async function main() {
  assert.throws(() => validateRuntimeConfig({ nodeEnv: 'production', sessionSecret: 'production-session-secret', sessionMaxAgeSeconds: 3600, telegramWebhookSecret: '' }), /TELEGRAM_WEBHOOK_SECRET/, 'production startup fails safely without a webhook secret');
  const productionOAuthConfig = { nodeEnv: 'production', isProduction: true, sessionSecret: 'production-session-secret', sessionMaxAgeSeconds: 3600, telegramWebhookSecret: 'safe_webhook_secret', vkOAuthClientId: '54723764', vkOAuthAuthorizeUrl: 'https://id.vk.ru/authorize', vkOAuthTokenUrl: 'https://id.vk.ru/oauth2/auth', webappUrl: 'http://life.example' };
  assert.throws(() => validateRuntimeConfig(productionOAuthConfig), /HTTPS|WEBAPP_URL/i, 'production VK OAuth refuses an insecure callback/app origin');
  assert.throws(() => validateRuntimeConfig({ ...productionOAuthConfig, webappUrl: 'https://life.example', vkOAuthTokenUrl: 'http://127.0.0.1:4124/token' }), /provider endpoints/i, 'production VK OAuth refuses local provider endpoint overrides');
  const now = 2_000_000_000_000;
  assert.deepEqual(inspectToken(createToken(42, now), now + 1_000), { userId: 42, status: 'valid' }, 'fresh session token is valid');
  assert.equal(inspectToken(createToken(42, now), now + 3_600_000).status, 'expired', 'session token expires at the configured boundary');
  assert.equal(inspectToken('broken.token.value', now).status, 'invalid', 'malformed session token is rejected without throwing');
  assert.equal(inspectToken(createToken(42, now + 120_000), now).status, 'invalid', 'token issued too far in the future is rejected');

  getDb();
  const proofTargetUser = createDemoUser('OAuth proof target', 'ru', '', 'UTC');
  const browserBinding = 'browser-binding-that-is-long-and-random-enough-123456';
  const intent = createOAuthIntent({ action: 'link', userId: proofTargetUser.id, refCode: 'ABC123', timezone: 'Europe/Moscow', locale: 'en' });
  assert.match(intent.intent, /^[A-Za-z0-9_-]{20,80}$/, 'VK OAuth intent is short and opaque');
  assert.match(intent.channel, /^[A-Za-z0-9_-]{20,80}$/, 'VK OAuth handoff channel is short and opaque');
  const authorizeUrl = new URL(beginOAuthIntent(intent.intent, browserBinding));
  const oauthState = authorizeUrl.searchParams.get('state');
  assert.match(oauthState, /^[A-Za-z0-9_-]{20,80}$/, 'VK OAuth URL contains only a short opaque state');
  assert(!authorizeUrl.toString().includes('codeVerifier') && !authorizeUrl.toString().includes('ABC123'), 'VK OAuth URL does not expose verifier or app context');
  const oauthContext = consumeState(oauthState, browserBinding);
  assert.equal(oauthContext.action, 'link', 'server-side VK OAuth state keeps link action');
  assert.equal(oauthContext.userId, proofTargetUser.id, 'server-side VK OAuth state keeps initiating user');
  assert.equal(oauthContext.channel, intent.channel, 'server-side VK OAuth state keeps the exact handoff channel');
  assert(oauthContext.codeVerifier.length >= 43, 'PKCE verifier is retained server-side');
  assert.throws(() => consumeState(oauthState, browserBinding), /invalid|used|expired/i, 'VK OAuth state cannot be replayed');
  assert.throws(() => beginOAuthIntent(intent.intent, browserBinding), /invalid|used|expired/i, 'VK OAuth intent cannot be replayed');
  const linkProof = createOAuthLinkProof({ targetUserId: proofTargetUser.id, vkId: '770099', channel: intent.channel }, now);
  assert.match(linkProof, /^[A-Za-z0-9_-]{20,80}$/, 'verified VK link proof is opaque and short-lived');
  assert.throws(() => consumeOAuthLinkProof(linkProof, proofTargetUser.id + 1, now + 1), /target|session/i, 'foreign app session cannot consume another account link proof');
  assert.deepEqual(consumeOAuthLinkProof(linkProof, proofTargetUser.id, now + 2), { targetUserId: proofTargetUser.id, vkId: '770099', channel: intent.channel }, 'original target session consumes its immutable verified VK result');
  assert.throws(() => consumeOAuthLinkProof(linkProof, proofTargetUser.id, now + 3), /invalid|used|expired/i, 'verified VK link proof cannot be replayed');
  const expiredLinkProof = createOAuthLinkProof({ targetUserId: proofTargetUser.id, vkId: '770100', channel: intent.channel }, 1000);
  assert.throws(() => consumeOAuthLinkProof(expiredLinkProof, proofTargetUser.id, 601000), /invalid|expired/i, 'verified VK link proof expires at the OAuth state boundary');
  const secondIntent = createOAuthIntent({ action: 'auth' });
  const secondState = new URL(beginOAuthIntent(secondIntent.intent, browserBinding)).searchParams.get('state');
  assert.throws(() => consumeState(secondState, 'different-browser-binding-that-is-long-enough-123'), /browser|invalid/i, 'VK OAuth state is bound to initiating browser');
  const originalOAuthFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user_id: 'not-a-vk-id' }) });
  try {
    await assert.rejects(() => exchangeCode({ code: 'test-code', deviceId: 'test-device', state: secondState, codeVerifier: 'a'.repeat(48) }), /user|identity/i, 'OAuth provider identity must be a numeric VK user id');
  } finally {
    global.fetch = originalOAuthFetch;
  }
  const expiringIntent = createOAuthIntent({ action: 'auth' }, 1000);
  const expiringState = new URL(beginOAuthIntent(expiringIntent.intent, browserBinding, 1000)).searchParams.get('state');
  assert.throws(() => consumeState(expiringState, browserBinding, 601000), /expired|invalid/i, 'VK OAuth state expires exactly at its configured boundary');
  const expiredIntent = createOAuthIntent({ action: 'auth' }, 1000);
  assert.throws(() => beginOAuthIntent(expiredIntent.intent, browserBinding, 601000), /expired|invalid/i, 'VK OAuth intent expires at the configured boundary');
  const handoff = buildOAuthHandoffDocument({ type: 'kopilka:vk-oauth', channel: intent.channel, token: 'test-app-token' }, 'https://life.blinddev.xyz');
  assert(handoff.html.includes('https://life.blinddev.xyz') && handoff.html.includes('kopilka:vk-oauth'), 'OAuth callback handoff names the exact configured app origin and typed message');
  assert(!handoff.html.includes("postMessage(payload, '*')") && !handoff.html.includes('targetOrigin = "*"'), 'OAuth handoff never uses wildcard postMessage');
  assert(handoff.csp.includes("frame-ancestors 'none'") && handoff.csp.includes(`script-src 'nonce-${handoff.nonce}'`), 'OAuth callback document is frame-blocked and nonce-scripted');
  const linkHandoff = buildOAuthHandoffDocument({ type: 'kopilka:vk-oauth', channel: intent.channel, action: 'link', linkProof: 'p'.repeat(32), mergeToken: 'must-not-cross-callback' }, 'https://life.blinddev.xyz');
  assert(linkHandoff.html.includes('"linkProof"') && !linkHandoff.html.includes('must-not-cross-callback') && !linkHandoff.html.includes('"mergeToken"'), 'OAuth callback can carry only verified link proof, never a usable merge token');

  const inlineResults = buildInlineQueryResults('Текст https://life.blinddev.xyz/p/ABC123', 'ru');
  assert.equal(inlineResults[0].reply_markup.inline_keyboard[0][0].url, 'https://life.blinddev.xyz/p/ABC123', 'inline share uses an HTTPS URL button for arbitrary chats');
  assert.equal(inlineResults[0].reply_markup.inline_keyboard[0][0].web_app, undefined, 'inline share never uses private-chat-only web_app buttons');
  const inlineDestination = (text) => buildInlineQueryResults(text, 'ru')[0].reply_markup.inline_keyboard[0][0].url;
  assert.equal(inlineDestination('Реферальная ссылка https://life.blinddev.xyz/?ref=ABC123'), 'https://life.blinddev.xyz/?ref=ABC123', 'canonical app referral query is preserved');
  assert.equal(inlineDestination('Бот https://t.me/HarborLifeBot?startapp=ABC123'), 'https://t.me/HarborLifeBot?startapp=ABC123', 'exact configured Telegram bot destination is preserved');
  assert.equal(inlineDestination('VK https://vk.com/app54723764#ref=ABC123'), 'https://vk.com/app54723764#ref=ABC123', 'exact configured VK app destination is preserved');
  assert.equal(inlineDestination('Ложный сайт https://life.blinddev.xyz.evil.example/p/ABC123'), 'https://life.blinddev.xyz/', 'app-origin lookalike falls back to the canonical app');
  assert.equal(inlineDestination('Ложный Telegram https://t.me.evil.example/HarborLifeBot?startapp=ABC123'), 'https://life.blinddev.xyz/', 'Telegram hostname lookalike falls back to the canonical app');
  assert.equal(inlineDestination('Лишний путь https://t.me/HarborLifeBot/other'), 'https://life.blinddev.xyz/', 'configured bot hostname does not trust arbitrary account paths');
  assert.equal(inlineDestination('Чужой бот https://t.me/NotHarborLifeBot?startapp=ABC123'), 'https://life.blinddev.xyz/', 'another Telegram bot cannot own the branded open button');
  assert.equal(inlineDestination('Ложный VK https://vk.com.evil.example/app54723764'), 'https://life.blinddev.xyz/', 'VK hostname lookalike falls back to the canonical app');
  assert.equal(inlineDestination('Чужое VK-приложение https://vk.com/app99999999#ref=ABC123'), 'https://life.blinddev.xyz/', 'another VK app cannot own the branded open button');
  assert.equal(inlineDestination('Любой URL https://evil.example/collect'), 'https://life.blinddev.xyz/', 'arbitrary HTTPS URL falls back to the canonical app');
  assert.equal(parseMode(['--info']), 'info', 'webhook CLI supports read-only info mode');
  assert.equal(parseMode(['info']), null, 'webhook CLI rejects undocumented bare modes');
  const setPayload = buildSetWebhookPayload('https://life.blinddev.xyz/telegram/webhook', 'audit_test_webhook_secret');
  assert.deepEqual(setPayload.allowed_updates, ['message', 'edited_message', 'inline_query'], 'webhook subscription includes inline queries');
  assert.equal(setPayload.secret_token, 'audit_test_webhook_secret', 'setWebhook payload includes configured secret');

  assert(TELEGRAM_OUTBOUND_TIMEOUT_MS < PROCESSING_LEASE_MS, 'Telegram outbound timeout is shorter than the update processing lease');
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalNodeEnv = config.nodeEnv;
  try {
    config.nodeEnv = 'development';
    global.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
    global.clearTimeout = () => {};
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('bounded outbound timeout'), { name: 'AbortError' })), { once: true });
    });
    await assert.rejects(callTelegram('sendMessage', { chat_id: 1, text: 'timeout fixture' }), /bounded outbound timeout/, 'Telegram outbound request is aborted at its bounded timeout');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    config.nodeEnv = originalNodeEnv;
  }
  const leaseStart = Date.now();
  const firstClaim = claimUpdate(900001, leaseStart);
  assert.equal(firstClaim.claimed, true, 'new Telegram update is claimed');
  const inFlightClaim = claimUpdate(900001, leaseStart + 1_000);
  assert.equal(inFlightClaim.claimed, false, 'in-flight Telegram update is not processed twice');
  assert.equal(inFlightClaim.done, false, 'in-flight update is distinct from a completed duplicate');
  assert(inFlightClaim.retryAfterMs > 0, 'in-flight update reports a bounded retry delay');
  const reclaimedClaim = claimUpdate(900001, leaseStart + PROCESSING_LEASE_MS);
  assert.equal(reclaimedClaim.claimed, true, 'a simulated crashed worker is reclaimed after the stale lease');
  assert(reclaimedClaim.attempt > firstClaim.attempt, 'stale reclaim advances the fencing generation');
  assert.equal(markUpdateDone(900001, firstClaim.attempt, leaseStart + PROCESSING_LEASE_MS + 1), false, 'stale worker cannot mark a newer claim done');
  assert.equal(markUpdateFailed(900001, firstClaim.attempt, 'late stale failure', leaseStart + PROCESSING_LEASE_MS + 2), false, 'stale worker cannot fail a newer claim');
  assert.equal(markUpdateFailed(900001, reclaimedClaim.attempt, 'temporary failure', leaseStart + PROCESSING_LEASE_MS + 3), true, 'current worker can release a failed delivery for retry');
  const retryClaim = claimUpdate(900001, leaseStart + PROCESSING_LEASE_MS + 4);
  assert.equal(retryClaim.claimed, true, 'failed Telegram delivery can be retried');
  assert.equal(markUpdateDone(900001, retryClaim.attempt, leaseStart + PROCESSING_LEASE_MS + 5), true, 'current successful worker can complete the update');
  assert.equal(claimUpdate(900001, leaseStart + PROCESSING_LEASE_MS + 6).done, true, 'successfully delivered Telegram update is durably deduplicated');
  const oldClaim = claimUpdate(900002, 0);
  markUpdateFailed(900002, oldClaim.attempt, 'old transient failure', 0);
  claimUpdate(900003, 15 * 24 * 60 * 60 * 1000);
  assert.equal(getDb().prepare('SELECT 1 FROM telegram_updates WHERE update_id = 900002').get(), undefined, 'old failed update rows are pruned so dedup storage stays bounded');

  const app = createApp();
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(url, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(`${baseUrl}${url}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  let response = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'History One', locale: 'ru', timezone: 'UTC' }) });
  const userOne = response.data.user.id;
  const authOne = { authorization: `Bearer ${response.data.token}` };
  response = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'History Two', locale: 'ru', timezone: 'UTC' }) });
  const userTwo = response.data.user.id;
  const authTwo = { authorization: `Bearer ${response.data.token}` };

  const db = getDb();
  const eastUser = db.prepare("INSERT INTO users (telegram_id, first_name, timezone, locale) VALUES ('audit-east', 'East', 'Pacific/Kiritimati', 'ru')").run().lastInsertRowid;
  const westUser = db.prepare("INSERT INTO users (telegram_id, first_name, timezone, locale) VALUES ('audit-west', 'West', 'America/Adak', 'ru')").run().lastInsertRowid;
  const timezoneBoundary = new Date('2026-08-20T23:30:00.000Z');
  assert.equal(todayForUser(eastUser, timezoneBoundary), '2026-08-21', 'history day follows the user timezone east of UTC');
  assert.equal(todayForUser(westUser, timezoneBoundary), '2026-08-20', 'history day follows the user timezone west of UTC');
  const inserted = db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'первоначальная заметка', 1, '2026-08-20')").run(userOne);
  const legacyNote = 'Л'.repeat(1023);
  const legacyEntry = db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'movement', 'Движение', ?, 2, '2026-08-19')").run(userOne, legacyNote);
  const systemEntry = db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'weekly_contract', 'Договор', '', 10, '2026-08-20')").run(userOne);
  db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'sleep', 'Сон', 'чужая заметка', 3, '2026-08-20')").run(userTwo);

  response = await request('/api/history?date=2026-08-20&days=7', { headers: authOne });
  assert.equal(response.res.status, 200, 'bounded history endpoint accepts a valid date');
  assert.equal(response.data.selectedEntries.length, 2, 'history returns all entries for selected day');
  assert(response.data.selectedEntries.some((entry) => entry.note === 'первоначальная заметка' && entry.editable), 'ordinary daily entry is editable');
  assert(response.data.selectedEntries.some((entry) => entry.type === 'weekly_contract' && !entry.editable), 'system bonus entry is not editable');
  assert(!JSON.stringify(response.data).includes('чужая заметка'), 'history is isolated by user');
  response = await request('/api/history?date=2026-08-20&days=lots', { headers: authOne });
  assert.equal(response.res.status, 400, 'history rejects an invalid page-size parameter');
  response = await request('/api/history?date=2026-02-30&days=7', { headers: authOne });
  assert.equal(response.res.status, 400, 'history rejects impossible calendar dates');
  response = await request('/api/history?date=2026-08-20&days=1000', { headers: authOne });
  assert.equal(response.res.status, 400, 'history rejects unbounded page sizes');

  response = await request(`/api/entries/${inserted.lastInsertRowid}`, { method: 'PATCH', headers: authOne, body: JSON.stringify({ note: 'исправленная заметка' }) });
  assert.equal(response.res.status, 200, 'owner can edit note on daily entry');
  assert.equal(response.data.entry.note, 'исправленная заметка', 'edited note is returned');
  const editedLegacyNote = `${legacyNote} продолжение`;
  response = await request(`/api/entries/${legacyEntry.lastInsertRowid}`, { method: 'PATCH', headers: authOne, body: JSON.stringify({ note: editedLegacyNote }) });
  assert.equal(response.res.status, 200, 'legacy note longer than 500 characters remains editable');
  assert.equal(response.data.entry.note, editedLegacyNote, 'editing a supported legacy note never silently truncates it');
  const supportedLongNote = 'N'.repeat(1200);
  response = await request('/api/entries', { method: 'POST', headers: authOne, body: JSON.stringify({ type: 'savoring', note: supportedLongNote }) });
  assert.equal(response.res.status, 201, 'new notes use the same documented limit as History editing');
  assert.equal(response.data.entry.note, supportedLongNote, 'new supported long note is stored in full');
  response = await request('/api/entries', { method: 'POST', headers: authOne, body: JSON.stringify({ type: 'dreamed', note: 'X'.repeat(2001) }) });
  assert.equal(response.res.status, 400, 'over-limit new note is rejected rather than truncated');
  assert(response.data.error.includes('2000'), 'over-limit note receives a clear localized limit error');
  response = await request(`/api/entries/${inserted.lastInsertRowid}`, { method: 'PATCH', headers: authTwo, body: JSON.stringify({ note: 'взлом' }) });
  assert.equal(response.res.status, 404, 'another user cannot edit an entry');
  db.prepare("INSERT INTO user_artifacts (user_id, artifact_id, trigger_entry_id) VALUES (?, 'bear_warm_shelter', ?)").run(userOne, inserted.lastInsertRowid);
  response = await request(`/api/entries/${systemEntry.lastInsertRowid}`, { method: 'DELETE', headers: authOne, body: JSON.stringify({ confirm: true }) });
  assert.equal(response.res.status, 400, 'system/contract bonus cannot be deleted through history');
  response = await request(`/api/entries/${inserted.lastInsertRowid}`, { method: 'DELETE', headers: authOne, body: JSON.stringify({ confirm: false }) });
  assert.equal(response.res.status, 400, 'delete requires explicit confirmation');
  response = await request(`/api/entries/${inserted.lastInsertRowid}`, { method: 'DELETE', headers: authOne, body: JSON.stringify({ confirm: true }) });
  assert.equal(response.res.status, 200, 'confirmed daily entry deletion succeeds');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM entries WHERE id = ?').get(inserted.lastInsertRowid).count, 0, 'deleted entry is removed transactionally');
  const retainedArtifact = db.prepare("SELECT trigger_entry_id FROM user_artifacts WHERE user_id = ? AND artifact_id = 'bear_warm_shelter'").get(userOne);
  assert(retainedArtifact && retainedArtifact.trigger_entry_id === null, 'encountered artifacts are retained without punishment when an entry is deleted');

  const artifactUser = await request('/api/auth/dev', { method: 'POST', body: JSON.stringify({ firstName: 'Artifact EN', locale: 'en', timezone: 'UTC' }) });
  const artifactUserId = artifactUser.data.user.id;
  const artifactAuth = { authorization: `Bearer ${artifactUser.data.token}` };
  db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'recovery_bonus', 'Recovery', '', 11, '2026-08-01')").run(artifactUserId);
  response = await request('/api/entries', { method: 'POST', headers: artifactAuth, body: JSON.stringify({ type: 'food_water' }) });
  const cat = response.data.awardedArtifacts.find((artifact) => artifact.id === 'cat_life_warmer');
  assert(cat && !/[А-Яа-яЁё]/.test(JSON.stringify(cat)), 'newly awarded artifact is fully localized to English');
  response = await request('/api/artifacts', { headers: artifactAuth });
  const hidden = response.data.artifacts.filter((artifact) => !artifact.unlocked);
  assert(hidden.length > 1 && new Set(hidden.map((artifact) => artifact.lockedText)).size === 1, 'hidden artifact cards share concise non-revealing copy');
  assert(!hidden.some((artifact) => /cat|dog|bear|dragon|bee|sloth|hedgehog|beaver|turtle|nightingale/i.test(JSON.stringify(artifact))), 'hidden artifact identities remain secret in English');

  const webhookHeaders = { 'x-telegram-bot-api-secret-token': process.env.TELEGRAM_WEBHOOK_SECRET };
  const liveHttpClaim = claimUpdate(910000);
  response = await request('/telegram/webhook', { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ update_id: 910000, message: { text: '/start', chat: { id: 554 }, from: { language_code: 'ru' } } }) });
  assert.equal(response.res.status, 503, 'retry during a live claim receives a retryable non-2xx response');
  assert(Number(response.res.headers.get('retry-after')) >= 1, 'in-flight retry includes Retry-After');
  markUpdateFailed(910000, liveHttpClaim.attempt, 'simulated crash release');
  const requestFetch = global.fetch;
  config.nodeEnv = 'development';
  global.fetch = (url, options) => String(url).startsWith('https://api.telegram.org/')
    ? Promise.reject(new Error('fixture transient delivery failure'))
    : requestFetch(url, options);
  const originalDeliveryError = console.error;
  const deliveryErrors = [];
  console.error = (...args) => deliveryErrors.push(args.join(' '));
  try {
    response = await request('/telegram/webhook', { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ update_id: 910002, message: { text: '/start', chat: { id: 556 }, from: { language_code: 'ru' } } }) });
    assert.equal(response.res.status, 500, 'transient outbound delivery failure remains retryable');
  } finally {
    global.fetch = requestFetch;
    config.nodeEnv = 'test';
    console.error = originalDeliveryError;
  }
  assert.equal(deliveryErrors.filter((line) => line.includes('fixture transient delivery failure')).length, 1, 'transient delivery failure is logged once without retry side effects');
  assert.equal(getDb().prepare('SELECT status FROM telegram_updates WHERE update_id = 910002').get().status, 'failed', 'failed delivery releases the durable claim');
  response = await request('/telegram/webhook', { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ update_id: 910002, message: { text: '/start', chat: { id: 556 }, from: { language_code: 'ru' } } }) });
  assert.equal(response.res.status, 200, 'Telegram retries can complete after a transient delivery failure');
  response = await request('/telegram/webhook', { method: 'POST', body: '{malformed-json' });
  assert.equal(response.res.status, 403, 'webhook secret is checked before JSON body parsing');
  response = await request('/telegram/webhook', { method: 'POST', body: JSON.stringify({ update_id: 910001, message: { text: '/start', chat: { id: 555 }, from: { language_code: 'ru' } } }) });
  assert.equal(response.res.status, 403, 'unsigned Telegram webhook update is rejected before handling');
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    response = await request('/telegram/webhook', { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ update_id: 910001, message: { text: '/start', chat: { id: 555 }, from: { language_code: 'ru' } } }) });
    assert.equal(response.res.status, 200, 'signed Telegram webhook update is processed');
    response = await request('/telegram/webhook', { method: 'POST', headers: webhookHeaders, body: JSON.stringify({ update_id: 910001, message: { text: '/start', chat: { id: 555 }, from: { language_code: 'ru' } } }) });
    assert.equal(response.res.status, 200, 'duplicate successful update is acknowledged');
    assert.equal(response.data.done, true, 'HTTP 200 duplicate acknowledgement is reserved for completed updates');
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.filter((line) => line.includes('[telegram:dry] sendMessage')).length, 1, 'duplicate update does not repeat outbound delivery');

  await new Promise((resolve) => server.close(resolve));
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  console.log('audit tests passed');
}

main().catch((error) => {
  console.error(error);
  closeDb();
  process.exit(1);
});
