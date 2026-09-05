const crypto = require('crypto');
const config = require('../config');
function sign(payload) { return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url'); }
function createToken(userId, now = Date.now()) {
  const maxAgeMs = Math.max(300, Number(config.sessionMaxAgeSeconds) || 604800) * 1000;
  const payload = Buffer.from(JSON.stringify({ v: 1, userId: Number(userId), iat: now, exp: now + maxAgeMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function inspectToken(token, now = Date.now()) {
  try {
    if (!token || typeof token !== 'string') return { userId: null, status: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { userId: null, status: 'invalid' };
    const [payload, signature] = parts;
    const expected = sign(payload);
    const supplied = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) return { userId: null, status: 'invalid' };
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const userId = Number(data.userId);
    const issuedAt = Number(data.iat);
    const expiresAt = Number(data.exp);
    if (data.v !== 1 || !Number.isSafeInteger(userId) || userId < 1 || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return { userId: null, status: 'invalid' };
    if (issuedAt > now + 60_000) return { userId: null, status: 'invalid' };
    if (now >= expiresAt) return { userId: null, status: 'expired' };
    return { userId, status: 'valid' };
  } catch (_) {
    return { userId: null, status: 'invalid' };
  }
}
function verifyToken(token) {
  const result = inspectToken(token);
  return result.status === 'valid' ? result.userId : null;
}
module.exports = { createToken, verifyToken, inspectToken };
