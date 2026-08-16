const crypto = require('crypto');

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Validates the Telegram Login Widget callback payload (site login).
// The Login Widget signs with secret_key = SHA256(bot_token) (NOT the
// "WebAppData" HMAC used by the Mini App initData), so it needs its own check.
// Accepts either an object {id, first_name, username, auth_date, hash, ...}
// or a raw URLSearchParams/string of the same fields.
function validateTelegramLogin(loginData, botToken, options = {}) {
  if (!botToken) throw new Error('BOT_TOKEN is required for Telegram login');
  if (!loginData) throw new Error('loginData is empty');

  const params = loginData instanceof URLSearchParams
    ? loginData
    : new URLSearchParams(typeof loginData === 'string' ? loginData : Object.entries(loginData));

  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('loginData hash is missing');

  const authDate = Number(params.get('auth_date') || 0);
  const maxAgeSeconds = options.maxAgeSeconds || 86400;
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) throw new Error('loginData is too old');

  // Build data_check_string from all fields except hash, sorted, k=v joined by \n.
  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  // Login Widget secret: SHA256 of the bot token (raw bytes).
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!safeEqualHex(expectedHash, receivedHash)) throw new Error('loginData hash is invalid');

  const id = Number(params.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw new Error('Telegram user id is missing');

  return {
    user: {
      id,
      first_name: params.get('first_name') || '',
      last_name: params.get('last_name') || '',
      username: params.get('username') || '',
      language_code: params.get('language_code') || ''
    },
    authDate,
    queryId: params.get('query_id') || ''
  };
}

module.exports = { validateTelegramLogin };
