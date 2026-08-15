const crypto = require('crypto');
function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function validateTelegramInitData(initData, botToken, options = {}) {
  if (!botToken) throw new Error('BOT_TOKEN is required for Telegram auth');
  if (!initData || typeof initData !== 'string') throw new Error('initData is empty');
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('initData hash is missing');
  params.delete('hash');
  const authDate = Number(params.get('auth_date') || 0);
  const maxAgeSeconds = options.maxAgeSeconds || 86400;
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) throw new Error('initData is too old');
  const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expectedHash, receivedHash)) throw new Error('initData hash is invalid');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Telegram user id is missing');
  return { user, authDate, queryId: params.get('query_id') };
}
module.exports = { validateTelegramInitData };
