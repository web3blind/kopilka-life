const crypto = require('crypto');
const webpush = require('web-push');
const config = require('../config');
const { getDb } = require('../db');

// Never accept arbitrary remote URLs: web-push resolves/connects endpoints itself.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
function validateSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid push subscription');
  const { endpoint, keys } = input;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || endpoint.length < 60 ||
      !keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Invalid push subscription');
  let url;
  try { url = new URL(endpoint); } catch (_) { throw new Error('Invalid push endpoint'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      !PUSH_HOSTS.has(url.hostname) || !url.pathname.startsWith('/') || url.pathname === '/' ||
      url.href !== endpoint || /%(?:2f|5c|00)/i.test(url.pathname)) throw new Error('Invalid push endpoint');
  if (typeof keys.p256dh !== 'string' || !/^[A-Za-z0-9_-]{86,88}$/.test(keys.p256dh) ||
      typeof keys.auth !== 'string' || !/^[A-Za-z0-9_-]{22,24}$/.test(keys.auth)) throw new Error('Invalid push keys');
  const publicKey = Buffer.from(keys.p256dh, 'base64url');
  const auth = Buffer.from(keys.auth, 'base64url');
  if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) throw new Error('Invalid push keys');
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}
function endpointHash(endpoint) { return crypto.createHash('sha256').update(endpoint).digest('hex'); }
function validVapidSubject(subject) {
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject || '')) return true;
  try {
    const url = new URL(subject);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash && (url.href === subject || url.origin === subject);
  } catch (_) { return false; }
}
function configured() {
  return Boolean(/^[A-Za-z0-9_-]{86,88}$/.test(config.vapidPublicKey || '') &&
    /^[A-Za-z0-9_-]{42,44}$/.test(config.vapidPrivateKey || '') &&
    validVapidSubject(config.vapidSubject));
}
function listSubscriptions(userId) {
  return getDb().prepare('SELECT id, endpoint_hash FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(userId);
}
function subscribe(userId, input) {
  if (!configured()) throw new Error('Push is not configured');
  const sub = validateSubscription(input);
  const db = getDb(), hash = endpointHash(sub.endpoint);
  return db.transaction(() => {
    const owner = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint_hash = ?').get(hash);
    // A prior account must explicitly unsubscribe in its own session. Never silently transfer.
    if (owner && owner.user_id !== userId) throw new Error('This browser is linked to another account');
    const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
    if (!owner && count >= 10) throw new Error('Too many browser subscriptions');
    db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint_hash,endpoint,p256dh,auth,session_revision)
      VALUES(?,?,?,?,?,(SELECT session_revision FROM users WHERE id = ?))
      ON CONFLICT(endpoint_hash) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,
        session_revision=excluded.session_revision,updated_at=CURRENT_TIMESTAMP`)
      .run(userId, hash, sub.endpoint, sub.p256dh, sub.auth, userId);
    return { subscribed: true };
  })();
}
function unsubscribe(userId, endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new Error('Invalid push endpoint');
  const db = getDb();
  const result = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ? AND endpoint = ?')
    .run(userId, endpointHash(endpoint), endpoint);
  return { subscribed: false, removed: result.changes === 1 };
}
async function sendPush(row, locale, extraText) {
  if (!configured()) throw new Error('Push is not configured');
  // Validate again before network: preexisting database rows must never become an SSRF bypass.
  const sub = validateSubscription({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  const ru = locale !== 'en';
  const payload = JSON.stringify({ title: ru ? 'Копилка жизни' : 'Life Harbor',
    body: (ru ? 'Если есть силы, можно пополнить Копилку жизни.' : 'If you have the energy, you can add a little to Life Harbor.') + (extraText ? ` ${extraText}` : ''),
    url: '/' });
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
    { TTL: 3600, timeout: 12000, urgency: 'normal' });
}
module.exports = { configured, validateSubscription, endpointHash, listSubscriptions, subscribe, unsubscribe, sendPush };
