const { getDb } = require('../db');
const { ENTRY_TYPES } = require('./entriesService');
const { publicUser, getUserById, userHasOwnedData } = require('./usersService');
const { createMergeToken, verifyMergeToken } = require('../auth/mergeToken');

const QUICK_TYPES = new Set(ENTRY_TYPES);

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

function buildMergePreview(primaryUserId, sourceUserId) {
  const db = getDb();
  const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(primaryUserId);
  const source = db.prepare('SELECT * FROM users WHERE id = ?').get(sourceUserId);
  if (!primary || !source || primary.id === source.id) throw new Error('merge users invalid');

  const sourceEntries = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY entry_date, id').all(source.id);
  let movedEntries = 0;
  let dedupedQuickEntries = 0;
  let mergedNotes = 0;
  for (const entry of sourceEntries) {
    if (QUICK_TYPES.has(entry.type)) {
      const target = db.prepare('SELECT id, note FROM entries WHERE user_id = ? AND entry_date = ? AND type = ?').get(primary.id, entry.entry_date, entry.type);
      if (target) {
        dedupedQuickEntries += 1;
        if (entry.note && entry.note !== target.note) mergedNotes += 1;
        continue;
      }
    }
    movedEntries += 1;
  }
  const primaryStats = accountStats(primary.id);
  const sourceStats = accountStats(source.id);
  const blocking = [];
  // Only a VK-only source can be retired: never discard another login identity.
  if (!source.vk_id || source.telegram_id !== `vk:${source.vk_id}`) blocking.push('source_telegram_conflict');
  if (primary.vk_id && primary.vk_id !== source.vk_id) blocking.push('primary_vk_conflict');
  // Opaque provider metadata has no lossless conflict representation in this schema.
  if (count(db, `SELECT COUNT(*) AS count FROM user_support_actions a
    JOIN user_support_actions b ON a.action_id = b.action_id
    WHERE a.user_id = ? AND b.user_id = ? AND a.metadata_json IS NOT NULL
      AND b.metadata_json IS NOT NULL AND a.metadata_json != b.metadata_json`, [primary.id, source.id])) blocking.push('support_metadata_conflict');
  if (primaryStats.activeContracts > 0 && sourceStats.activeContracts > 0) blocking.push('active_contract_conflict');
  const scheduledRemindersDropped = count(db, "SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND status = 'scheduled' AND sent_at IS NULL", [source.id]);
  const referredMoved = count(db, 'SELECT COUNT(*) AS count FROM users WHERE referrer_id = ?', [source.id]);
  return {
    primary: publicUser(primary),
    source: publicUser(source),
    primaryStats,
    sourceStats,
    result: {
      movedEntries,
      dedupedQuickEntries,
      mergedNotes,
      movedContracts: sourceStats.contracts,
      scheduledRemindersDropped,
      referredMoved,
      willLinkVk: Boolean(source.vk_id)
    },
    blocking,
    canMerge: blocking.length === 0
  };
}

function buildVkMergeOffer(primaryUserId, vkId) {
  const candidate = findVkMergeCandidate(primaryUserId, vkId);
  if (!candidate) return null;
  const preview = buildMergePreview(candidate.primary.id, candidate.source.id);
  const disposableVkOnly = candidate.source.telegram_id === `vk:${candidate.source.vk_id}` && !userHasOwnedData(candidate.source.id);
  if (disposableVkOnly && preview.canMerge) return null;
  return { mergeRequired: true, mergeToken: createMergeToken({ primaryUserId: candidate.primary.id, sourceUserId: candidate.source.id, vkId }), preview };
}

function appendMergedNote(targetNote, sourceNote) {
  const cleanTarget = String(targetNote || '').trim();
  const cleanSource = String(sourceNote || '').trim();
  if (!cleanSource || cleanSource === cleanTarget) return targetNote || '';
  if (!cleanTarget) return `Из слитого аккаунта: ${cleanSource}`;
  return `${cleanTarget}\n\nИз слитого аккаунта: ${cleanSource}`;
}

// Union unique collectibles and support progress before the source user's cascade.
function mergeCollections(db, primaryId, sourceId) {
  db.prepare(`INSERT INTO user_artifacts (user_id, artifact_id, trigger_entry_id, awarded_at)
    SELECT ?, artifact_id, trigger_entry_id, awarded_at FROM user_artifacts WHERE user_id = ?
    ON CONFLICT(user_id, artifact_id) DO UPDATE SET
      trigger_entry_id = CASE WHEN excluded.awarded_at < user_artifacts.awarded_at
        THEN COALESCE(excluded.trigger_entry_id, user_artifacts.trigger_entry_id)
        ELSE COALESCE(user_artifacts.trigger_entry_id, excluded.trigger_entry_id) END,
      awarded_at = MIN(user_artifacts.awarded_at, excluded.awarded_at)`).run(primaryId, sourceId);
  db.prepare(`INSERT INTO user_support_actions
      (user_id, action_id, status, opened_at, claimed_at, verified_at, credited_at, source, metadata_json, created_at, updated_at)
    SELECT ?, action_id, status, opened_at, claimed_at, verified_at, credited_at, source, metadata_json, created_at, updated_at
    FROM user_support_actions WHERE user_id = ?
    ON CONFLICT(user_id, action_id) DO UPDATE SET
      status = CASE
        WHEN user_support_actions.verified_at IS NOT NULL THEN user_support_actions.status
        WHEN excluded.verified_at IS NOT NULL THEN excluded.status
        WHEN user_support_actions.credited_at IS NOT NULL THEN user_support_actions.status
        WHEN excluded.credited_at IS NOT NULL THEN excluded.status
        WHEN user_support_actions.claimed_at IS NOT NULL THEN user_support_actions.status
        WHEN excluded.claimed_at IS NOT NULL THEN excluded.status
        WHEN user_support_actions.opened_at IS NOT NULL THEN user_support_actions.status
        ELSE excluded.status END,
      opened_at = COALESCE(MIN(user_support_actions.opened_at, excluded.opened_at), user_support_actions.opened_at, excluded.opened_at),
      claimed_at = COALESCE(MIN(user_support_actions.claimed_at, excluded.claimed_at), user_support_actions.claimed_at, excluded.claimed_at),
      verified_at = COALESCE(MIN(user_support_actions.verified_at, excluded.verified_at), user_support_actions.verified_at, excluded.verified_at),
      credited_at = COALESCE(MIN(user_support_actions.credited_at, excluded.credited_at), user_support_actions.credited_at, excluded.credited_at),
      source = COALESCE(user_support_actions.source, excluded.source),
      metadata_json = COALESCE(user_support_actions.metadata_json, excluded.metadata_json),
      created_at = MIN(user_support_actions.created_at, excluded.created_at),
      updated_at = MAX(user_support_actions.updated_at, excluded.updated_at)`).run(primaryId, sourceId);
}

function applyMergeByToken(token, currentUserId) {
  const data = verifyMergeToken(token);
  if (Number(currentUserId) !== data.primaryUserId) throw new Error('merge token target mismatch');
  const db = getDb();
  let preview;
  const tx = db.transaction(() => {
    preview = buildMergePreview(data.primaryUserId, data.sourceUserId);
    if (!preview.canMerge) {
      const error = new Error('merge blocked');
      error.preview = preview;
      throw error;
    }
    const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(data.primaryUserId);
    const source = db.prepare('SELECT * FROM users WHERE id = ?').get(data.sourceUserId);
    if (!primary || !source || String(source.vk_id) !== data.vkId) throw new Error('merge source changed');

    const entries = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY entry_date, id').all(source.id);
    for (const entry of entries) {
      if (QUICK_TYPES.has(entry.type)) {
        const target = db.prepare('SELECT id, note FROM entries WHERE user_id = ? AND entry_date = ? AND type = ?').get(primary.id, entry.entry_date, entry.type);
        if (target) {
          db.prepare('UPDATE entries SET note = ? WHERE id = ?').run(appendMergedNote(target.note, entry.note), target.id);
          db.prepare('UPDATE user_artifacts SET trigger_entry_id = ? WHERE trigger_entry_id = ?').run(target.id, entry.id);
          db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
          continue;
        }
      }
      db.prepare('UPDATE entries SET user_id = ? WHERE id = ?').run(primary.id, entry.id);
    }

    mergeCollections(db, primary.id, source.id);
    db.prepare('UPDATE weekly_contracts SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
    db.prepare("DELETE FROM reminders WHERE user_id = ? AND status = 'scheduled' AND sent_at IS NULL").run(source.id);
    for (const reminder of db.prepare('SELECT * FROM reminders WHERE user_id = ?').all(source.id)) {
      const target = db.prepare('SELECT * FROM reminders WHERE user_id = ? AND type = ? AND due_at = ?').get(primary.id, reminder.type, reminder.due_at);
      if (target) {
        const sentAt = target.sent_at || reminder.sent_at;
        db.prepare('UPDATE reminders SET sent_at = ?, status = ? WHERE id = ?').run(sentAt, sentAt ? 'sent' : target.status, target.id);
        db.prepare('DELETE FROM reminders WHERE id = ?').run(reminder.id);
      } else {
        db.prepare('UPDATE reminders SET user_id = ? WHERE id = ?').run(primary.id, reminder.id);
      }
    }
    db.prepare('UPDATE users SET referrer_id = ? WHERE referrer_id = ?').run(primary.id, source.id);
    db.prepare('UPDATE users SET referrer_id = NULL WHERE id = ? AND referrer_id = id').run(primary.id);
    if (!primary.referrer_id && source.referrer_id && source.referrer_id !== primary.id && source.referrer_id !== source.id) {
      db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(source.referrer_id, primary.id);
    }
    db.prepare('UPDATE users SET vk_id = NULL WHERE id = ?').run(source.id);
    db.prepare('UPDATE users SET vk_id = ?, vk_messages_allowed = ?, vk_messages_allowed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(source.vk_id, source.vk_messages_allowed, source.vk_messages_allowed_at, primary.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(source.id);
  });
  tx();
  return { preview, user: getUserById(data.primaryUserId) };
}

module.exports = { accountStats, buildMergePreview, buildVkMergeOffer, applyMergeByToken };
