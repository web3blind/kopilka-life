const { getDb } = require('../db');
const { ENTRY_TYPES, ENTRY_POINTS } = require('./entriesService');
const { publicUser, getUserById } = require('./usersService');
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
  const stats = accountStats(candidate.source.id);
  const disposableVkOnly = String(candidate.source.telegram_id || '').startsWith('vk:') && stats.entries + stats.contracts + stats.reminders === 0;
  if (disposableVkOnly) return null;
  const preview = buildMergePreview(candidate.primary.id, candidate.source.id);
  return { mergeRequired: true, mergeToken: createMergeToken({ primaryUserId: candidate.primary.id, sourceUserId: candidate.source.id, vkId }), preview };
}

function appendMergedNote(targetNote, sourceNote) {
  const cleanTarget = String(targetNote || '').trim();
  const cleanSource = String(sourceNote || '').trim();
  if (!cleanSource || cleanSource === cleanTarget) return targetNote || '';
  if (!cleanTarget) return `Из слитого аккаунта: ${cleanSource}`;
  return `${cleanTarget}\n\nИз слитого аккаунта: ${cleanSource}`.slice(0, 1500);
}

function applyMergeByToken(token, currentUserId) {
  const data = verifyMergeToken(token);
  if (Number(currentUserId) !== data.primaryUserId) throw new Error('merge token target mismatch');
  const db = getDb();
  const preview = buildMergePreview(data.primaryUserId, data.sourceUserId);
  if (!preview.canMerge) {
    const error = new Error('merge blocked');
    error.preview = preview;
    throw error;
  }
  const tx = db.transaction(() => {
    const primary = db.prepare('SELECT * FROM users WHERE id = ?').get(data.primaryUserId);
    const source = db.prepare('SELECT * FROM users WHERE id = ?').get(data.sourceUserId);
    if (!primary || !source || String(source.vk_id) !== data.vkId) throw new Error('merge source changed');

    const entries = db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY entry_date, id').all(source.id);
    for (const entry of entries) {
      if (QUICK_TYPES.has(entry.type)) {
        const target = db.prepare('SELECT id, note FROM entries WHERE user_id = ? AND entry_date = ? AND type = ?').get(primary.id, entry.entry_date, entry.type);
        if (target) {
          db.prepare('UPDATE entries SET note = ? WHERE id = ?').run(appendMergedNote(target.note, entry.note), target.id);
          db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
          continue;
        }
      }
      db.prepare('UPDATE entries SET user_id = ? WHERE id = ?').run(primary.id, entry.id);
    }

    db.prepare('UPDATE weekly_contracts SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
    db.prepare("DELETE FROM reminders WHERE user_id = ? AND status = 'scheduled' AND sent_at IS NULL").run(source.id);
    db.prepare('UPDATE reminders SET user_id = ? WHERE user_id = ?').run(primary.id, source.id);
    db.prepare('UPDATE users SET referrer_id = ? WHERE referrer_id = ?').run(primary.id, source.id);
    if (!primary.referrer_id && source.referrer_id && source.referrer_id !== primary.id) {
      db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(source.referrer_id, primary.id);
    }
    db.prepare('UPDATE users SET vk_id = NULL WHERE id = ?').run(source.id);
    db.prepare('UPDATE users SET vk_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(source.vk_id, primary.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(source.id);
  });
  tx();
  return { preview, user: getUserById(data.primaryUserId) };
}

module.exports = { accountStats, buildMergePreview, buildVkMergeOffer, applyMergeByToken };
