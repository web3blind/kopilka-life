const crypto = require('node:crypto');
const { getDb } = require('../db');
const { publicUser } = require('./usersService');
const { accountStats } = require('./accountMergeService');
const { recordBlockers, moveRecords, moveReferrals } = require('./mergeRecords');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function sessionHash(token) { return digest(String(token || '')); }
const numericTelegram = row => /^\d+$/.test(String(row.telegram_id || ''));
const synthetic = row => /^(email|google|vk|demo):/.test(String(row.telegram_id || ''));
function identityOwner(db, provider, subject) {
  if (provider === 'telegram') return db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(subject)?.id || null;
  return db.prepare('SELECT user_id FROM login_identities WHERE provider = ? AND subject = ?').get(provider, subject)?.user_id || null;
}
function arrangement(db, currentId, otherId) {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(currentId);
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!current || !other || current.id === other.id) throw new Error('Account changed. Start linking again.');
  // Preserve an existing Telegram profile, otherwise an existing VK profile, then
  // the account which initiated the link. Never substitute a synthetic profile.
  const survivor = numericTelegram(other) && !numericTelegram(current) ? other :
    numericTelegram(current) && !numericTelegram(other) ? current :
    other.vk_id && !current.vk_id ? other : current;
  return { survivor, retiring: survivor.id === current.id ? other : current };
}
function preview(db, currentId, otherId) {
  const { survivor, retiring } = arrangement(db, currentId, otherId);
  const blocking = [];
  if (survivor.is_demo || retiring.is_demo) blocking.push('demo_account_conflict');
  if (survivor.vk_id && retiring.vk_id && survivor.vk_id !== retiring.vk_id) blocking.push('primary_vk_conflict');
  if (numericTelegram(survivor) && numericTelegram(retiring) && survivor.telegram_id !== retiring.telegram_id) blocking.push('primary_telegram_conflict');
  if (!numericTelegram(survivor) && !synthetic(survivor)) blocking.push('unknown_platform_identity');
  if (!numericTelegram(retiring) && !synthetic(retiring)) blocking.push('unknown_platform_identity');
  const logins = db.prepare('SELECT provider,subject FROM login_identities WHERE user_id = ?').all(retiring.id);
  const existing = db.prepare('SELECT provider,subject FROM login_identities WHERE user_id = ?').all(survivor.id);
  for (const login of logins) {
    if (existing.some(row => row.provider === login.provider)) blocking.push(`${login.provider}_identity_conflict`);
  }
  blocking.push(...recordBlockers(db, survivor.id, retiring.id));
  if (db.prepare("SELECT COUNT(*) AS n FROM weekly_contracts WHERE user_id IN (?,?) AND status = 'active'").get(survivor.id, retiring.id).n > 1) blocking.push('active_contract_conflict');
  if (survivor.referrer_id && retiring.referrer_id && survivor.referrer_id !== retiring.referrer_id) blocking.push('referrer_conflict');
  // Never retire a user's platform notification preference/clock silently.
  if (retiring.reminders_enabled && survivor.reminders_enabled &&
      (survivor.timezone !== retiring.timezone || survivor.evening_reminder_time !== retiring.evening_reminder_time)) blocking.push('settings_conflict');
  if (retiring.reminders_enabled && !survivor.reminders_enabled) blocking.push('settings_conflict');
  return { primary: publicUser(survivor), source: publicUser(retiring), primaryStats: accountStats(survivor.id), sourceStats: accountStats(retiring.id),
    result: { transferLogins: true, movedEntries: accountStats(retiring.id).entries, movedContracts: accountStats(retiring.id).contracts,
      retainedLogins: [...new Set([...existing.map(x => x.provider), ...logins.map(x => x.provider), ...(survivor.vk_id || retiring.vk_id ? ['vk'] : []), ...(numericTelegram(survivor) || numericTelegram(retiring) ? ['telegram'] : [])])].sort(),
      scheduledRemindersDropped: 0, survivorRule: 'telegram_then_vk_then_current', settingsRule: 'survivor',
      timezone: survivor.timezone, remindersEnabled: Boolean(survivor.reminders_enabled),
      retainedRefCodes: [survivor.ref_code, retiring.ref_code].filter(Boolean).length }, blocking: [...new Set(blocking)], canMerge: blocking.length === 0 };
}
function createOffer({ currentId, provider, subject, session = '', sessionHashValue = '' }) {
  const boundHash = session ? sessionHash(session) : sessionHashValue;
  if (!['email', 'google', 'telegram'].includes(provider) || !subject || !/^[a-f0-9]{64}$/.test(boundHash)) throw new Error('Verified identity required');
  const db = getDb();
  const otherId = identityOwner(db, provider, String(subject));
  if (!otherId || otherId === currentId) throw new Error('Identity is not occupied');
  const result = preview(db, currentId, otherId);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM account_merge_offers WHERE expires_at < ?').run(Math.floor(Date.now() / 1000));
  db.prepare('INSERT INTO account_merge_offers (token_hash,current_user_id,other_user_id,provider,subject,session_hash,expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(digest(token), currentId, otherId, provider, String(subject), boundHash, Math.floor(Date.now()/1000)+600);
  return { mergeRequired: true, mergeToken: token, preview: result };
}
function readOffer(token, session, currentId) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !session) throw new Error('Invalid merge offer');
  const db = getDb();
  const row = db.prepare('SELECT * FROM account_merge_offers WHERE token_hash = ?').get(digest(token));
  if (!row || row.expires_at < Date.now()/1000 || row.current_user_id !== currentId || row.session_hash !== sessionHash(session) ||
      identityOwner(db, row.provider, row.subject) !== row.other_user_id) throw new Error('Merge offer expired or session changed');
  return row;
}
function confirmOffer(token, session, currentId) {
  const db = getDb();
  return db.transaction(() => {
    const offer = readOffer(token, session, currentId);
    const result = preview(db, offer.current_user_id, offer.other_user_id);
    if (!result.canMerge) { const error = new Error('Merge blocked'); error.preview = result; throw error; }
    const primaryId = result.primary.id, sourceId = result.source.id;
    const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(primaryId);
    const source = db.prepare('SELECT * FROM users WHERE id = ?').get(sourceId);
    // Free UNIQUE fields before moving them to the survivor. The deleted row has
    // no independent login identity left; no provider binding is thrown away.
    if (source.vk_id) db.prepare('UPDATE users SET vk_id = NULL WHERE id = ?').run(sourceId);
    if (numericTelegram(source)) db.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(`merged:${source.id}`, sourceId);
    if (!primary.vk_id && source.vk_id) db.prepare('UPDATE users SET vk_id = ?, vk_messages_allowed = ?, vk_messages_allowed_at = ? WHERE id = ?')
      .run(source.vk_id, source.vk_messages_allowed, source.vk_messages_allowed_at, primaryId);
    if (!numericTelegram(primary) && numericTelegram(source)) db.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(source.telegram_id, primaryId);
    moveRecords(db, primaryId, sourceId);
    db.prepare('UPDATE login_identities SET user_id = ? WHERE user_id = ?').run(primaryId, sourceId);
    for (const table of ['email_login_codes','google_oauth_states','google_oauth_intents']) {
      const column = table === 'email_login_codes' ? 'requested_by' : 'user_id';
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(sourceId); // unfinished auth must be re-proven
    }
    moveReferrals(db, primary, source);
    db.prepare('DELETE FROM account_merge_offers WHERE token_hash = ?').run(digest(token));
    db.prepare('DELETE FROM users WHERE id = ?').run(sourceId);
    if (db.pragma('foreign_key_check').length) throw new Error('Foreign-key integrity failure');
    return { preview: result, user: db.prepare('SELECT * FROM users WHERE id = ?').get(primaryId) };
  })();
}
module.exports = { sessionHash, identityOwner, createOffer, readOffer, confirmOffer, preview };
