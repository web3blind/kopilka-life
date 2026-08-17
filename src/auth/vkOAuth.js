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
  return `${payload}.${sign(payload)}`;
}

function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
  if (!state || typeof state !== 'string' || !state.includes('.')) throw new Error('VK OAuth state is missing');
  const [payload, signature] = state.split('.');
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
  if (!config.vkAppId) throw new Error('VK_APP_ID is not configured');
  const verifier = randomBase64Url(48);
  const state = createState({ action, userId, refCode, timezone, locale, codeVerifier: verifier });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.vkAppId,
    redirect_uri: oauthRedirectUri(),
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return `https://id.vk.ru/authorize?${params.toString()}`;
}

async function exchangeCode({ code, deviceId, state, codeVerifier }) {
  if (!config.vkAppId) throw new Error('VK_APP_ID is not configured');
  if (!code) throw new Error('VK OAuth code is missing');
  if (!deviceId) throw new Error('VK OAuth device_id is missing');
  if (!codeVerifier) throw new Error('VK OAuth code_verifier is missing');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
    redirect_uri: oauthRedirectUri(),
    code,
    client_id: config.vkAppId,
    device_id: deviceId,
    state,
  });
  const response = await fetch('https://id.vk.ru/oauth2/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.user_id) {
    const message = data.error_description || data.error || `VK OAuth exchange failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

module.exports = { buildAuthorizeUrl, exchangeCode, verifyState, oauthRedirectUri, codeChallenge, createState };
