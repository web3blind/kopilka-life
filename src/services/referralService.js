const { getDb } = require('../db');
const { localDateInTimeZone } = require('../utils/timezone');
const { ensureRefCode, getUserById } = require('./usersService');
const { getSummary, getWeekSummary } = require('./entriesService');

function userTimeZone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }

// Number of referred people who have made at least one entry (active invites).
function activeReferredCount(userId) {
  return getDb().prepare(`
    SELECT COUNT(*) AS count FROM users u
    WHERE u.referrer_id = ? AND u.is_demo = 0
      AND EXISTS (SELECT 1 FROM entries e WHERE e.user_id = u.id)
  `).get(userId).count;
}
// Number of users who ever signed up via this referrer (all signups, active or not).
function totalReferredCount(userId) {
  return getDb().prepare('SELECT COUNT(*) AS count FROM users WHERE referrer_id = ? AND is_demo = 0').get(userId).count;
}
// Number of distinct clicks/visits that carried this ref code: we treat every
// signed-up invite as a visit, since a bare anonymous visit without signup is
// not reliably attributable. The heart badge counts ACTIVE referred people.
function visitCount(userId) {
  return totalReferredCount(userId);
}
function profileStats(userId) {
  return {
    refCode: ensureRefCode(userId),
    activeReferred: activeReferredCount(userId),
    totalReferred: totalReferredCount(userId),
    visits: visitCount(userId)
  };
}
function publicProfileByCode(code) {
  const row = getDb().prepare('SELECT * FROM users WHERE ref_code = ? COLLATE NOCASE AND is_demo = 0').get(String(code || '').trim().toUpperCase());
  if (!row) return null;
  const firstName = row.first_name || row.username || 'Life Harbor user';
  const today = getSummary(row.id);
  const week = getWeekSummary(row.id);
  // Public projection: aggregates and category names only, NEVER personal notes.
  return {
    firstName,
    username: row.username,
    refCode: row.ref_code,
    activeReferred: activeReferredCount(row.id),
    totalReferred: totalReferredCount(row.id),
    today: {
      totalLife: today.totalLife,
      todayLife: today.todayLife,
      categories: (today.todayEntries || []).map((e) => e.title)
    },
    week: {
      weekLife: week.weekLife,
      activeDays: week.activeDays,
      days: (week.days || []).map((d) => ({ date: d.date, life: d.life, categories: d.titles })),
      topCategories: week.topCategories
    }
  };
}
// Credits the referrer (+1 LIFE) the first time the referred user makes an entry.
// Returns true if a bonus was granted this call.
function grantReferrerBonusOnFirstEntry(referredUserId) {
  const db = getDb();
  const user = db.prepare('SELECT referrer_id, referrer_bonus_granted FROM users WHERE id = ?').get(referredUserId);
  if (!user || !user.referrer_id || user.referrer_bonus_granted) return false;
  const referrer = getUserById(user.referrer_id);
  if (!referrer || referrer.is_demo) return false;
  const entryDate = localDateInTimeZone(new Date(), userTimeZone(user.referrer_id));
  db.transaction(() => {
    db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'referral', 'Активный приглашённый человек', '', 1, ?)").run(user.referrer_id, entryDate);
    db.prepare('UPDATE users SET referrer_bonus_granted = 1 WHERE id = ?').run(referredUserId);
  })();
  return true;
}
module.exports = { profileStats, publicProfileByCode, grantReferrerBonusOnFirstEntry, activeReferredCount, totalReferredCount, visitCount };
