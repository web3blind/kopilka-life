const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const { fetchVkJson } = require('../vkMessages');

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validBrowserBinding(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function pruneStates(db, now) {
  db.prepare('DELETE FROM vk_oauth_states WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at < ?)').run(now, now - 60 * 60 * 1000);
  db.prepare('DELETE FROM vk_oauth_intents WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at < ?)').run(now, now - 60 * 60 * 1000);
  db.prepare('DELETE FROM vk_oauth_link_proofs WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at < ?)').run(now, now - 60 * 60 * 1000);
}

function validOpaque(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(value);
}

function oauthContext({ action = 'auth', userId = null, refCode = '', timezone = '', locale = 'ru' } = {}) {
  return {
    action: action === 'link' ? 'link' : 'auth',
    userId: userId ? Number(userId) : null,
    refCode: String(refCode || '').slice(0, 64),
    timezone: String(timezone || '').slice(0, 80),
    locale: String(locale || '').slice(0, 8)
  };
}

function stateTtlMs() {
  return Math.max(60, Number(config.vkOAuthStateMaxAgeSeconds) || 600) * 1000;
}

function createOAuthIntent(context = {}, now = Date.now()) {
  const intent = randomBase64Url(24);
  if (context.channel !== undefined && !validOpaque(context.channel)) throw new Error('VK OAuth handoff channel is invalid');
  const channel = context.channel || randomBase64Url(24);
  const db = getDb();
  pruneStates(db, now);
  db.prepare('INSERT INTO vk_oauth_intents (intent_hash, context_json, channel, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(hash(intent), JSON.stringify(oauthContext(context)), channel, now + stateTtlMs(), now);
  return { intent, channel };
}

function createOAuthLinkProof({ targetUserId, vkId, channel }, now = Date.now()) {
  const target = Number(targetUserId);
  const providerUserId = String(vkId || '');
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('VK OAuth link target is invalid');
  if (!/^[1-9]\d{0,19}$/.test(providerUserId)) throw new Error('VK OAuth provider identity is invalid');
  if (!validOpaque(channel)) throw new Error('VK OAuth handoff channel is invalid');
  const proof = randomBase64Url(24);
  const db = getDb();
  pruneStates(db, now);
  db.prepare('INSERT INTO vk_oauth_link_proofs (proof_hash, target_user_id, vk_id, channel, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash(proof), target, providerUserId, channel, now + stateTtlMs(), now);
  return proof;
}

function consumeOAuthLinkProof(proof, targetUserId, now = Date.now()) {
  if (!validOpaque(proof)) throw new Error('VK OAuth link proof is invalid');
  const target = Number(targetUserId);
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('VK OAuth link target session is invalid');
  const db = getDb();
  return db.transaction(() => {
    pruneStates(db, now);
    const row = db.prepare('SELECT * FROM vk_oauth_link_proofs WHERE proof_hash = ?').get(hash(proof));
    if (!row || row.consumed_at !== null || row.expires_at <= now) throw new Error('VK OAuth link proof is invalid, used, or expired');
    if (Number(row.target_user_id) !== target) throw new Error('VK OAuth link target session does not match');
    const consumed = db.prepare('UPDATE vk_oauth_link_proofs SET consumed_at = ? WHERE proof_hash = ? AND consumed_at IS NULL').run(now, row.proof_hash);
    if (consumed.changes !== 1) throw new Error('VK OAuth link proof is invalid, used, or expired');
    return { targetUserId: target, vkId: String(row.vk_id), channel: String(row.channel) };
  })();
}

function consumeState(state, browserBinding, now = Date.now()) {
  if (!validOpaque(state)) throw new Error('VK OAuth state is invalid');
  if (!validBrowserBinding(browserBinding)) throw new Error('VK OAuth browser binding is invalid');
  const db = getDb();
  return db.transaction(() => {
    pruneStates(db, now);
    const row = db.prepare('SELECT * FROM vk_oauth_states WHERE state_hash = ?').get(hash(state));
    if (!row || row.consumed_at !== null || row.expires_at <= now) throw new Error('VK OAuth state is invalid, used, or expired');
    if (row.browser_hash !== hash(browserBinding)) throw new Error('VK OAuth browser binding is invalid');
    const consumed = db.prepare('UPDATE vk_oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL').run(now, row.state_hash);
    if (consumed.changes !== 1) throw new Error('VK OAuth state is invalid, used, or expired');
    const context = JSON.parse(row.context_json);
    return { ...context, codeVerifier: row.code_verifier };
  })();
}

function oauthRedirectUri() {
  return `${config.webappUrl.replace(/\/$/, '')}/api/auth/vk-oauth/callback`;
}

function beginOAuthIntent(intent, browserBinding, now = Date.now()) {
  if (!config.vkOAuthClientId) throw new Error('VK OAuth client id is not configured');
  if (!validOpaque(intent)) throw new Error('VK OAuth intent is invalid');
  if (!validBrowserBinding(browserBinding)) throw new Error('VK OAuth browser binding is invalid');
  const db = getDb();
  const started = db.transaction(() => {
    pruneStates(db, now);
    const row = db.prepare('SELECT * FROM vk_oauth_intents WHERE intent_hash = ?').get(hash(intent));
    if (!row || row.consumed_at !== null || row.expires_at <= now) throw new Error('VK OAuth intent is invalid, used, or expired');
    const consumed = db.prepare('UPDATE vk_oauth_intents SET consumed_at = ? WHERE intent_hash = ? AND consumed_at IS NULL').run(now, row.intent_hash);
    if (consumed.changes !== 1) throw new Error('VK OAuth intent is invalid, used, or expired');
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(48);
    const context = { ...JSON.parse(row.context_json), channel: row.channel };
    db.prepare('INSERT INTO vk_oauth_states (state_hash, browser_hash, code_verifier, context_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(state), hash(browserBinding), verifier, JSON.stringify(context), now + stateTtlMs(), now);
    return { state, verifier };
  })();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.vkOAuthClientId,
    redirect_uri: oauthRedirectUri(),
    state: started.state,
    code_challenge: codeChallenge(started.verifier),
    code_challenge_method: 'S256',
  });
  return `${config.vkOAuthAuthorizeUrl}?${params.toString()}`;
}

async function exchangeCode({ code, deviceId, state, codeVerifier }) {
  if (!config.vkOAuthClientId) throw new Error('VK OAuth client id is not configured');
  if (!code) throw new Error('VK OAuth code is missing');
  if (!deviceId) throw new Error('VK OAuth device_id is missing');
  if (!codeVerifier) throw new Error('VK OAuth code_verifier is missing');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
    redirect_uri: oauthRedirectUri(),
    code,
    client_id: config.vkOAuthClientId,
    device_id: deviceId,
    state,
  });
  if (config.vkOAuthClientSecret) body.set('client_secret', config.vkOAuthClientSecret);
  const { res, data } = await fetchVkJson(config.vkOAuthTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const providerUserId = String(data.user_id || '');
  if (!res.ok || !/^[1-9]\d{0,19}$/.test(providerUserId)) {
    const message = data.error_description || data.error || (res.ok ? 'VK OAuth provider identity is invalid' : `VK OAuth exchange failed (${res.status})`);
    throw new Error(message);
  }
  return { ...data, user_id: providerUserId };
}

function appOrigin() {
  const url = new URL(config.webappUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('App origin is invalid');
  return url.origin;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildOAuthHandoffDocument(payload, targetOrigin = appOrigin()) {
  const target = new URL(targetOrigin);
  if (target.origin !== targetOrigin || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('OAuth handoff origin is invalid');
  const nonce = randomBase64Url(18);
  const body = safeJson({
    type: 'kopilka:vk-oauth',
    channel: String(payload.channel || ''),
    action: payload.action === 'link' ? 'link' : 'auth',
    ...(payload.token ? { token: String(payload.token) } : {}),
    ...(payload.linkProof ? { linkProof: String(payload.linkProof) } : {}),
    ...(payload.error ? { error: String(payload.error).slice(0, 180) } : {})
  });
  const origin = safeJson(target.origin);
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK ID — Копилка жизни</title></head><body><main><h1>Возвращаемся в Копилку жизни</h1><p id="status" role="status">Завершаем вход…</p><p><a href="/?vk_oauth_return=1">Вернуться в приложение</a></p></main><script nonce="${nonce}">(() => { const payload=${body}; const targetOrigin=${origin}; const key='kopilkaVkOAuthHandoff'; sessionStorage.setItem(key, JSON.stringify(payload)); let acknowledged=false; const finishHere=()=>window.location.replace('/?vk_oauth_return=1'); window.addEventListener('message', event => { if (event.source === window.opener && event.origin === targetOrigin && event.data?.type === 'kopilka:vk-oauth-ack' && event.data?.channel === payload.channel) { acknowledged=true; window.close(); } }); if (window.opener && !window.opener.closed) { window.opener.postMessage(payload, targetOrigin); window.setTimeout(() => { if (!acknowledged) finishHere(); }, 1200); } else { finishHere(); } })();</script></body></html>`;
  return { html, nonce, csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; img-src 'none'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
}

function oauthCallbackHandoff(payload, targetOrigin) {
  sessionStorage.setItem('kopilkaVkOAuthHandoff', JSON.stringify(payload));
  let acknowledged = false;
  const finishHere = () => window.location.replace('/?vk_oauth_return=1');
  window.addEventListener('message', event => {
    if (event.source === window.opener && event.origin === targetOrigin &&
        event.data?.type === 'kopilka:vk-oauth-ack' && event.data?.channel === payload.channel) {
      acknowledged = true;
      window.close();
    }
  });
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(payload, targetOrigin);
    window.setTimeout(() => { if (!acknowledged) finishHere(); }, 1200);
  } else { finishHere(); }
}

async function oauthCallbackBootstrap(targetOrigin, handoff) {
  const status = document.getElementById('status');
  // A prerender can execute scripts. Wait for activation and a visible document;
  // a fetched/preloaded/background landing must not perform auth completion.
  if (document.prerendering) await new Promise(resolve => document.addEventListener('prerenderingchange', resolve, { once: true }));
  if (document.visibilityState !== 'visible') await new Promise(resolve => {
    const visible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', visible); resolve(); } };
    document.addEventListener('visibilitychange', visible);
  });
  const input = new URLSearchParams(location.search);
  const body = {};
  for (const key of ['state', 'code', 'device_id', 'error']) body[key] = input.get(key) || '';
  // Do not retain authorization codes in the address/history or handoff URL.
  history.replaceState(null, '', location.pathname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (location.origin !== targetOrigin || window.top !== window) throw new Error('origin');
    const response = await fetch('/api/auth/vk-oauth/complete', {
      method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok || payload.type !== 'kopilka:vk-oauth' ||
        !/^[A-Za-z0-9_-]{20,80}$/.test(payload.channel) || !['auth', 'link'].includes(payload.action) ||
        (!payload.error && !(payload.action === 'link' ? payload.linkProof : payload.token))) throw new Error('completion');
    handoff(payload, targetOrigin);
  } catch (_) {
    // Uncorrelated/replayed failure must not overwrite another successful handoff.
    status.textContent = 'Не удалось завершить вход через VK ID. Вернитесь в приложение и попробуйте снова.';
  } finally { clearTimeout(timeout); }
}

function buildOAuthCallbackDocument() {
  const nonce = randomBase64Url(18);
  const origin = safeJson(appOrigin());
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK ID — Копилка жизни</title></head><body><main><h1>Возвращаемся в Копилку жизни</h1><p id="status" role="status">Завершаем вход…</p><p><a href="/">Вернуться в приложение</a></p></main><script nonce="${nonce}">(${oauthCallbackBootstrap.toString()})(${origin}, ${oauthCallbackHandoff.toString()});</script></body></html>`;
  return { html, nonce, csp: `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
}

// Pass the snapshot synchronously via the new window's name, not a URL or
// partitioned storage. The first-party page clears it before any fetch/navigation.
function buildOAuthWindowDocument(retryAfter = 0) {
  const nonce = randomBase64Url(18);
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK ID — Копилка жизни</title></head><body><main><h1>VK ID</h1><p id="status" role="status">Подготавливаем безопасный вход…</p><p><a href="/">Вернуться в приложение</a></p></main><script nonce="${nonce}">(${oauthWindowBootstrap.toString()})(${safeJson(retryAfter)});</script></body></html>`;
  return { html, nonce, csp: `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` };
}

async function oauthWindowBootstrap(retryAfter = 0) {
  let context;
  let rawContext = window.name;
  window.name = '';
  const status = document.getElementById('status');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    context = JSON.parse(rawContext || 'null');
    rawContext = '';
    if (!context || !/^[A-Za-z0-9_-]{20,80}$/.test(context.channel) ||
        !['auth', 'link'].includes(context.action) || !Number.isFinite(context.createdAt) ||
        Math.abs(Date.now() - context.createdAt) > 60000 || (context.action === 'link' && !context.token)) {
      throw new Error('bootstrap');
    }
    if (retryAfter > 0) throw new Error('throttled');
    const response = await fetch('/api/auth/vk-oauth/intent', {
      method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(context.action === 'link' ? { authorization: 'Bearer ' + context.token } : {}) },
      body: JSON.stringify({ action: context.action, channel: context.channel, refCode: context.refCode, timezone: context.timezone, locale: context.locale })
    });
    const data = await response.json();
    if (response.status === 429) retryAfter = Number(response.headers.get('Retry-After')) || 0;
    if (!response.ok || data.channel !== context.channel) throw new Error('intent');
    const target = new URL(data.launchUrl, location.origin);
    if (target.origin !== location.origin || target.pathname !== '/api/auth/vk-oauth/start' ||
        target.username || target.password || !/^[A-Za-z0-9_-]{20,80}$/.test(target.searchParams.get('intent'))) throw new Error('launch');
    location.replace(target.href);
  } catch (_) {
    const en = context?.locale === 'en';
    if (document.documentElement) document.documentElement.lang = en ? 'en' : 'ru';
    status.textContent = retryAfter > 0
      ? (en ? `Too many sign-in attempts. Try again in ${retryAfter} seconds.` : `Слишком много попыток входа. Попробуй через ${retryAfter} сек.`)
      : 'Не удалось начать вход через VK ID. Вернитесь в приложение и попробуйте снова.';
    if (context && /^[A-Za-z0-9_-]{20,80}$/.test(context.channel) && ['auth', 'link'].includes(context.action) && Number.isFinite(context.createdAt) && Math.abs(Date.now() - context.createdAt) <= 60000 && window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'kopilka:vk-oauth', channel: context.channel, action: context.action, error: status.textContent, retryAfter }, location.origin);
    }
  } finally {
    rawContext = '';
    clearTimeout(timeout);
    if (context) delete context.token;
  }
}

module.exports = { buildOAuthCallbackDocument, buildOAuthWindowDocument, createOAuthIntent, beginOAuthIntent, exchangeCode, consumeState, createOAuthLinkProof, consumeOAuthLinkProof, oauthRedirectUri, codeChallenge, validBrowserBinding, buildOAuthHandoffDocument, appOrigin };
