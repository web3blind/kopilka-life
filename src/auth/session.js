const crypto = require('crypto');
const config = require('../config');
function sign(payload) { return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url'); }
function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return Number(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).userId) || null;
}
module.exports = { createToken, verifyToken };
