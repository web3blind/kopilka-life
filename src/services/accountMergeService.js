const { getDb } = require('../db');
const { ENTRY_TYPES } = require('./entriesService');
const { publicUser, getUserById, userHasOwnedData } = require('./usersService');
const { createMergeToken, verifyMergeToken } = require('../auth/mergeToken');
const { createHash } = require('node:crypto');
const { recordBlockers, moveRecords, moveReferrals } = require('./mergeRecords');

function count(db, sql, params = []) {
  return db.prepare(sql).get(...params).count;
}

function accountStats(userId) {
  const db = getDb();
  const quickEntries = count(db, `SELECT COUNT(*) AS count FROM entries WHERE user_id = ? AND type IN (${ENTRY_TYPES.map(() => '?').join(',')})`, [userId, ...ENTRY_TYPES]);
  return {
    entries: count(db, 'SELECT COUNT(*) AS count FROM entries WHERE user_id = ?', [userId]),
    quickEntries,
    systemEntries: count(db, `SELECT COUNT(*) AS count FROM entries WHERE user_id = ? AND type NOT IN (${ENTRY_TYPES.map(() => '?').join(',')})`, [userId, ...ENTRY_TYPES]),
    contracts: count(db, 'SELECT COUNT(*) AS count FROM weekly_contracts WHERE user_id = ?', [userId]),
    activeContracts: count(db, "SELECT COUNT(*) AS count FROM weekly_contracts WHERE user_id = ? AND status = 'active'", [userId]),
    artifacts: count(db, 'SELECT COUNT(*) AS count FROM user_artifacts WHERE user_id = ?', [userId]),
    supportActions: count(db, 'SELECT COUNT(*) AS count FROM user_support_actions WHERE user_id = ?', [userId]),
    reminders: count(db, 'SELECT COUNT(*) AS count FROM reminders WHERE user_id = ?', [userId]),
    totalLife: count(db, 'SELECT COALESCE(SUM(life_points), 0) AS count FROM entries WHERE user_id = ?', [userId])
  };
}

function findVkMergeCandidate(primaryUserId, vkId) {
  const db = getDb();
  const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(primaryUserId);
  const source = db.prepare('SELECT * FROM users WHERE vk_id = ?').get(String(vkId));
  if (!primary || !source || source.id === primary.id) return null;
  return { primary, source };
}

function buildMergePreview(primaryUserId, sourceUserId, { transferLogins = false } = {}) {
  const db = getDb();
  const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(primaryUserId);
  const source = db.prepare('SELECT * FROM users WHERE id = ?').get(sourceUserId);
  if (!primary || !source || primary.id === source.id) throw new Error('merge users invalid');

  const movedEntries = count(db, 'SELECT COUNT(*) AS count FROM entries WHERE user_id = ?', [source.id]);
  const primaryStats = accountStats(primary.id);
  const sourceStats = accountStats(source.id);
  const blocking = [];
  // A VK+Telegram profile survives; only a synthetic email/Google profile can be retired.
  if (transferLogins) {
    if (source.vk_id || !/^(email|google):/.test(String(source.telegram_id || '')) || !primary.vk_id) blocking.push('source_telegram_conflict');
    if (!count(db, 'SELECT COUNT(*) AS count FROM login_identities WHERE user_id = ?', [source.id]) ||
      count(db, `SELECT COUNT(*) AS count FROM login_identities s JOIN login_identities p
      ON s.provider = p.provider WHERE s.user_id = ? AND p.user_id = ?`, [source.id, primary.id])) blocking.push('source_identity_conflict');
  } else {
    if (!source.vk_id || source.telegram_id !== `vk:${source.vk_id}`) blocking.push('source_telegram_conflict');
    if (count(db, 'SELECT COUNT(*) AS count FROM login_identities WHERE user_id = ?', [source.id])) blocking.push('source_identity_conflict');
    if (primary.vk_id && primary.vk_id !== source.vk_id) blocking.push('primary_vk_conflict');
  }
  blocking.push(...recordBlockers(db, primary.id, source.id));
  if (primaryStats.activeContracts > 0 && sourceStats.activeContracts > 0) blocking.push('active_contract_conflict');
  if (primary.referrer_id && source.referrer_id && primary.referrer_id !== source.referrer_id) blocking.push('referrer_conflict');
  // Match the identity merge's survivor-settings rule: never discard a live clock.
  if (source.reminders_enabled && (!primary.reminders_enabled ||
      primary.timezone !== source.timezone || primary.evening_reminder_time !== source.evening_reminder_time))
    blocking.push('settings_conflict');
  const scheduledRemindersDropped = 0;
  const referredMoved = count(db, 'SELECT COUNT(*) AS count FROM users WHERE referrer_id = ?', [source.id]);
  return {
    primary: publicUser(primary),
    source: publicUser(source),
    primaryStats,
    sourceStats,
    result: {
      movedEntries,
      dedupedQuickEntries: 0,
      mergedNotes: 0,
      movedContracts: sourceStats.contracts,
      scheduledRemindersDropped,
      referredMoved,
      willLinkVk: Boolean(source.vk_id),
      transferLogins
    },
    blocking,
    canMerge: blocking.length === 0
  };
}

function buildVkMergeOffer(primaryUserId, vkId, session = '') {
  const candidate = findVkMergeCandidate(primaryUserId, vkId);
  if (!candidate) return null;
  const transferLogins = candidate.source.telegram_id !== `vk:${candidate.source.vk_id}` &&
    /^(email|google):/.test(String(candidate.primary.telegram_id || '')) && !candidate.primary.vk_id;
  const primary = transferLogins ? candidate.source : candidate.primary;
  const source = transferLogins ? candidate.primary : candidate.source;
  const preview = buildMergePreview(primary.id, source.id, { transferLogins });
  const disposableVkOnly = candidate.source.telegram_id === `vk:${candidate.source.vk_id}` && !userHasOwnedData(candidate.source.id);
  if (disposableVkOnly && preview.canMerge) return null;
  return { mergeRequired: true, mergeToken: createMergeToken({ primaryUserId: primary.id, sourceUserId: source.id, vkId, authenticatedUserId: candidate.primary.id,
    sessionHash: session ? createHash('sha256').update(session).digest('hex') : '' }), preview };
}

function applyMergeByToken(token, currentUserId, session = '') {
  const data = verifyMergeToken(token);
  if (Number(currentUserId) !== data.authenticatedUserId) throw new Error('merge token target mismatch');
  if (data.sessionHash && createHash('sha256').update(session).digest('hex') !== data.sessionHash) throw new Error('merge token session mismatch');
  const transferLogins = data.authenticatedUserId === data.sourceUserId;
  const db = getDb();
  let preview;
  const tx = db.transaction(() => {
    preview = buildMergePreview(data.primaryUserId, data.sourceUserId, { transferLogins });
    if (!preview.canMerge) {
      const error = new Error('merge blocked');
      error.preview = preview;
      throw error;
    }
    const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(data.primaryUserId);
    const source = db.prepare('SELECT * FROM users WHERE id = ?').get(data.sourceUserId);
    if (!primary || !source || String((transferLogins ? primary : source).vk_id) !== data.vkId) throw new Error('merge source changed');

    moveRecords(db, primary.id, source.id);
    moveReferrals(db, primary, source);
    if (transferLogins) {
      db.prepare('UPDATE login_identities SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
      db.prepare('UPDATE email_login_codes SET requested_by = ? WHERE requested_by = ?').run(primary.id, source.id);
      db.prepare('UPDATE google_oauth_states SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
      db.prepare('UPDATE google_oauth_intents SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
    } else {
      db.prepare('UPDATE users SET vk_id = NULL WHERE id = ?').run(source.id);
      db.prepare('UPDATE users SET vk_id = ?, vk_messages_allowed = ?, vk_messages_allowed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(source.vk_id, source.vk_messages_allowed, source.vk_messages_allowed_at, primary.id);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(source.id);
    if (db.pragma('foreign_key_check').length) throw new Error('Foreign-key integrity failure');
  });
  tx();
  return { preview, user: getUserById(data.primaryUserId) };
}

module.exports = { accountStats, buildMergePreview, buildVkMergeOffer, applyMergeByToken };
