const crypto = require('node:crypto');
const { getDb } = require('../db');
const { getUserById } = require('./usersService');
const { createOffer, sessionHash } = require('./identityMergeService');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const validIntent = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

function createLinkIntent(currentId, session) {
  if (!session || !getUserById(currentId)) throw new Error('Session required');
  const intent = crypto.randomBytes(32).toString('base64url');
  const db = getDb();
  db.prepare('DELETE FROM telegram_link_intents WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO telegram_link_intents (intent_hash,current_user_id,session_hash,expires_at) VALUES (?,?,?,?)')
    .run(digest(intent), currentId, sessionHash(session), now() + 600);
  return intent;
}

// Caller MUST pass bot-validated initData, including the signed start_param.
// The intent is a rendezvous identifier, never a bearer credential.
function claimLinkIntent(validated, startParam, proofHash) {
  const match = /^link_([A-Za-z0-9_-]{43})$/.exec(startParam || '');
  const id = String(validated?.user?.id || '');
  if (!match || !/^\d+$/.test(id) || !/^[a-f0-9]{64}$/i.test(proofHash || '')) throw new Error('Invalid Telegram proof');
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM telegram_link_intents WHERE intent_hash = ?').get(digest(match[1]));
    if (!row || row.expires_at < now() || row.telegram_id || row.consumed_at) throw new Error('Link intent expired or claimed');
    if (!db.prepare('UPDATE telegram_link_intents SET telegram_id = ?, proof_hash = ? WHERE intent_hash = ? AND telegram_id IS NULL')
      .run(id, proofHash, digest(match[1])).changes) throw new Error('Link intent claimed');
    return { ok: true };
  })();
}

function finishLinkIntent(currentId, session, intent) {
  if (!validIntent(intent) || !session) throw new Error('Invalid link intent');
  const db = getDb();
  return db.transaction(() => {
    const key = digest(intent);
    const row = db.prepare('SELECT * FROM telegram_link_intents WHERE intent_hash = ?').get(key);
    if (!row || row.current_user_id !== currentId || row.session_hash !== sessionHash(session) || row.expires_at < now() || row.consumed_at)
      throw new Error('Link intent expired or session changed');
    if (!row.telegram_id) return { pending: true };
    // The signed proof was verified in the other context. Its hash is unique to
    // that launch; the existing link service enforces replay protection.
    const result = linkVerifiedTelegram(currentId, { user: { id: row.telegram_id } }, `miniapp:${row.proof_hash}`, session);
    db.prepare('UPDATE telegram_link_intents SET consumed_at = ? WHERE intent_hash = ?').run(now(), key);
    return result;
  })();
}

function linkVerifiedTelegram(currentId, verified, proof, session) {
  const id = String(verified?.user?.id || '');
  if (!/^\d+$/.test(id) || !proof || !session) throw new Error('Telegram proof required');
  const db = getDb();
  return db.transaction(() => {
    const current = getUserById(currentId);
    if (!current || ( /^\d+$/.test(String(current.telegram_id || '')) && current.telegram_id !== id))
      throw new Error('Another Telegram account is already linked. Contact support.');
    const hash = crypto.createHash('sha256').update(String(proof)).digest('hex');
    db.prepare('DELETE FROM telegram_link_proofs WHERE expires_at < ?').run(Math.floor(Date.now()/1000));
    if (!db.prepare('INSERT OR IGNORE INTO telegram_link_proofs (proof_hash,expires_at) VALUES (?,?)')
      .run(hash, Math.floor(Date.now()/1000)+600).changes) throw new Error('Telegram proof already used');
    const other = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(id);
    if (other && other.id !== currentId) return createOffer({ currentId, provider: 'telegram', subject: id, session });
    if (!other) db.prepare('UPDATE users SET telegram_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id, currentId);
    return { user: getUserById(currentId) };
  })();
}
module.exports = { linkVerifiedTelegram, createLinkIntent, claimLinkIntent, finishLinkIntent };
