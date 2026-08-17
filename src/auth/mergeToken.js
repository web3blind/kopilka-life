const crypto = require('crypto');
const config = require('../config');

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function createMergeToken({ primaryUserId, sourceUserId, vkId }, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    primaryUserId: Number(primaryUserId),
    sourceUserId: Number(sourceUserId),
    vkId: String(vkId),
    iat: now
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyMergeToken(token, { maxAgeMs = 30 * 60 * 1000 } = {}) {
  if (!token || typeof token !== 'string' || !token.includes('.')) throw new Error('merge token invalid');
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (!signature || signature.length !== expected.length) throw new Error('merge token invalid');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('merge token invalid');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.primaryUserId || !data.sourceUserId || !data.vkId || !data.iat) throw new Error('merge token invalid');
  if (Date.now() - Number(data.iat) > maxAgeMs) throw new Error('merge token expired');
  return { primaryUserId: Number(data.primaryUserId), sourceUserId: Number(data.sourceUserId), vkId: String(data.vkId) };
}

module.exports = { createMergeToken, verifyMergeToken };
