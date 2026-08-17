const crypto = require('crypto');

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseLaunchParams(input) {
  if (!input || typeof input !== 'string') throw new Error('missing vk launch params');
  let raw = input.trim();
  if (!raw) throw new Error('missing vk launch params');
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    raw = url.search || url.hash || '';
  }
  while (raw.startsWith('#') || raw.startsWith('?')) raw = raw.slice(1);
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0) raw = raw.slice(queryIndex + 1);
  return new URLSearchParams(raw);
}

function validateVkLaunchParams(input, secureKey, options = {}) {
  if (!secureKey) throw new Error('vk secure key is not configured');
  const params = parseLaunchParams(input);
  const sign = params.get('sign');
  if (!sign) throw new Error('missing vk sign');
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key.startsWith('vk_')) pairs.push([key, value]);
  }
  if (!pairs.length) throw new Error('missing vk params');
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const expected = base64Url(crypto.createHmac('sha256', secureKey).update(dataCheckString).digest());
  if (!timingSafeEqualString(expected, sign)) throw new Error('invalid vk sign');

  const appId = params.get('vk_app_id');
  if (options.appId && String(appId) !== String(options.appId)) throw new Error('invalid vk app id');

  const userId = params.get('vk_user_id');
  if (!userId || !/^\d+$/.test(userId)) throw new Error('missing vk user id');

  const maxAgeSeconds = Number(options.maxAgeSeconds || 86400);
  const ts = Number(params.get('vk_ts') || 0);
  if (maxAgeSeconds > 0 && ts > 0) {
    const age = Math.floor(Date.now() / 1000) - ts;
    if (age > maxAgeSeconds) throw new Error('vk launch params too old');
    if (age < -300) throw new Error('vk launch params from the future');
  }

  return {
    vkId: String(userId),
    appId: String(appId || ''),
    language: params.get('vk_language') || params.get('vk_lang') || '',
    ref: params.get('vk_ref') || '',
    raw: Object.fromEntries(params.entries())
  };
}

module.exports = { validateVkLaunchParams, parseLaunchParams, base64Url };
