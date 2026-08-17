const crypto = require('crypto');
const config = require('../config');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function createState(data) {
  const payload = base64url(JSON.stringify({ ...data, iat: Date.now() }));
  const envelope = { payload, signature: sign(payload) };
  return base64url(JSON.stringify(envelope));
}

function parseStateEnvelope(state) {
  if (!state || typeof state !== 'string') throw new Error('VK OAuth state is missing');
  // Backward compatibility with the initial implementation. VK ID docs allow only
  // a-z, A-Z, 0-9, _ and - in state, so new states are packed as one base64url string.
  if (state.includes('.')) {
    const [payload, signature] = state.split('.');
    return { payload, signature };
  }
  const envelope = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  return { payload: envelope.payload, signature: envelope.signature };
}

function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  const { payload, signature } = parseStateEnvelope(state);
  const expected = sign(payload);
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('VK OAuth state is invalid');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.iat || Date.now() - Number(data.iat) > maxAgeMs) throw new Error('VK OAuth state is too old');
  return data;
}

function oauthRedirectUri() {
  return `${config.webappUrl.replace(/\/$/, '')}/api/auth/vk-oauth/callback`;
}

function buildAuthorizeUrl({ action = 'auth', userId = null, refCode = '', timezone = '', locale = 'ru' } = {}) {
  if (!config.vkOAuthClientId) throw new Error('VK OAuth client id is not configured');
  const verifier = randomBase64Url(32);
  const state = createState({ action, userId, refCode, timezone, locale, codeVerifier: verifier });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.vkOAuthClientId,
    redirect_uri: oauthRedirectUri(),
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return `https://id.vk.ru/authorize?${params.toString()}`;
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
  const res = await fetch('https://id.vk.ru/oauth2/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user_id) {
    const message = data.error_description || data.error || `VK OAuth exchange failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

module.exports = { buildAuthorizeUrl, exchangeCode, verifyState, oauthRedirectUri, codeChallenge, createState };
