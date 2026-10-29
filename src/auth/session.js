const crypto = require('crypto');
const config = require('../config');
function sign(payload) { return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url'); }
function createToken(userId, now = Date.now()) {
  const maxAgeMs = Math.max(300, Number(config.sessionMaxAgeSeconds) || 31536000) * 1000;
  const { getDb } = require('../db');
  const revision = getDb().prepare('SELECT session_revision FROM users WHERE id = ?').get(Number(userId))?.session_revision || 0;
  const payload = Buffer.from(JSON.stringify({ v: 1, userId: Number(userId), iat: now, exp: now + maxAgeMs, rev: revision, jti: crypto.randomBytes(24).toString('base64url') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function inspectToken(token, now = Date.now()) {
  try {
    if (!token || typeof token !== 'string' || token.length > 4096) return { userId: null, status: 'invalid' };
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
    if (data.v !== 1 || !Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0 || expiresAt > 8640000000000000 || expiresAt <= issuedAt) return { userId: null, status: 'invalid' };
    if (issuedAt > now + 60_000) return { userId: null, status: 'invalid' };
    if (now >= expiresAt) return { userId: null, status: 'expired' };
    return { userId, status: 'valid', ...(data.rev === undefined ? {} : { revision: data.rev }) };
  } catch (_) {
    return { userId: null, status: 'invalid' };
  }
}
function verifyToken(token) {
  const result = inspectActiveToken(token);
  return result.status === 'valid' ? result.userId : null;
}
function inspectActiveToken(token, now = Date.now()) {
  const result = inspectToken(token, now);
  if (result.status !== 'valid') return result;
  const { getDb } = require('../db');
  const user = getDb().prepare('SELECT session_revision FROM users WHERE id = ?').get(result.userId);
  if (!user || !Number.isSafeInteger(result.revision === undefined ? 0 : result.revision) ||
      (result.revision === undefined ? 0 : result.revision) !== user.session_revision)
    return { userId: null, status: 'invalid' };
  if (getDb().prepare('SELECT 1 FROM session_revocations WHERE token_hash = ?').get(tokenHash(token)))
    return { userId: null, status: 'revoked' };
  return result;
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function revokeToken(token) {
  const { getDb } = require('../db');
  const db = getDb();
  // BEGIN IMMEDIATE serializes revision/user checks with merge/delete and other
  // logouts, including across processes. A repeat cannot bypass those checks.
  return db.transaction(() => {
    const result = inspectToken(token);
    if (result.status !== 'valid') return result;
    const user = db.prepare('SELECT session_revision FROM users WHERE id = ?').get(result.userId);
    const revision = result.revision === undefined ? 0 : result.revision;
    if (!user || !Number.isSafeInteger(revision) || revision !== user.session_revision)
      return { userId: null, status: 'invalid' };
    const expiresAt = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).exp;
    db.prepare('INSERT INTO session_revocations(token_hash, expires_at) VALUES (?, ?) ON CONFLICT(token_hash) DO NOTHING')
      .run(tokenHash(token), Number(expiresAt));
    return { status: 'revoked', userId: result.userId };
  }).immediate();
}
module.exports = { createToken, verifyToken, inspectToken, inspectActiveToken, revokeToken };
