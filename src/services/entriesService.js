const { getDb } = require('../db');
const { localDateString, weekStartDateString } = require('../time');
const { normalizeLocale, t } = require('../i18n');
const { sanitizeText } = require('../utils/sanitize');

// Life points per entry type. Titles/hints are localized via i18n by type key.
const ENTRY_TYPES = ['sleep', 'movement', 'food_water', 'joy', 'gratitude', 'important_task', 'dream_step', 'kind_trace', 'honest_step', 'rest', 'hard_day'];
const ENTRY_POINTS = { sleep: 3, movement: 2, food_water: 1, joy: 1, gratitude: 1, important_task: 2, dream_step: 2, kind_trace: 1, honest_step: 2, rest: 1, hard_day: 1 };

function entryTitle(type, locale) {
  return t(locale, `entry.${type}.title`);
}
function entryHint(type, locale) {
  return t(locale, `entry.${type}.hint`);
}
function getUserTimezone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }
function getUserLocale(userId) { return normalizeLocale(getDb().prepare('SELECT locale FROM users WHERE id = ?').get(userId)?.locale); }
function todayForUser(userId, now = new Date()) { return localDateString(now, getUserTimezone(userId)); }
function createEntry(userId, type, note = '', locale) {
  if (!ENTRY_POINTS[type]) throw new Error('Неизвестный тип записи');
  const db = getDb();
  const lang = normalizeLocale(locale || getUserLocale(userId));
  const cleanNote = sanitizeText(note, { maxLength: 500 });
  const today = todayForUser(userId);
  const existing = db.prepare('SELECT id FROM entries WHERE user_id = ? AND entry_date = ? AND type = ?').get(userId, today, type);
  if (existing) throw new Error('Этот вариант уже добавлен сегодня. Завтра он снова будет доступен.');
  try {
    const info = db.prepare('INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, ?, ?, ?, ?, ?)').run(userId, type, entryTitle(type, lang), cleanNote, ENTRY_POINTS[type], today);
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('Этот вариант уже добавлен сегодня. Завтра он снова будет доступен.');
    throw error;
  }
}
function listEntries(userId, range = 'week') {
  const db = getDb();
  if (range === 'today') return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date = ? ORDER BY created_at DESC, id DESC').all(userId, todayForUser(userId));
  const since = weekStartDateString(new Date(), getUserTimezone(userId));
  return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date >= ? ORDER BY entry_date DESC, created_at DESC, id DESC').all(userId, since);
}
// Localized title for display (by type when available, fallback to stored title).
function displayTitle(entry, locale) {
  const lang = normalizeLocale(locale);
  const localized = ENTRY_POINTS[entry.type] ? entryTitle(entry.type, lang) : '';
  return localized || entry.title;
}
function getSummary(userId) {
  const db = getDb();
  const lang = getUserLocale(userId);
  const today = todayForUser(userId);
  const todayEntriesAll = listEntries(userId, 'today').map((e) => ({ ...e, title: displayTitle(e, lang) }));
  const todayEntries = todayEntriesAll.slice(0, 3);
  return {
    totalLife: db.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(userId).total,
    todayLife: db.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ? AND entry_date = ?').get(userId, today).total,
    todayEntries,
    todayEntryTypes: todayEntriesAll.map((entry) => entry.type).filter((type) => ENTRY_POINTS[type])
  };
}
function getWeekSummary(userId) {
  const lang = getUserLocale(userId);
  const entries = listEntries(userId, 'week');
  const days = new Map();
  const categories = new Map();
  entries.forEach((entry) => {
    const item = days.get(entry.entry_date) || { date: entry.entry_date, life: 0, titles: [] };
    item.life += entry.life_points;
    const title = displayTitle(entry, lang);
    if (!item.titles.includes(title)) item.titles.push(title);
    days.set(entry.entry_date, item);
    categories.set(title, (categories.get(title) || 0) + 1);
  });
  return {
    weekLife: entries.reduce((sum, entry) => sum + entry.life_points, 0),
    activeDays: days.size,
    days: Array.from(days.values()).sort((a, b) => b.date.localeCompare(a.date)),
    topCategories: Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, count]) => ({ title, count })),
    entries
  };
}
module.exports = { ENTRY_TYPES, ENTRY_POINTS, entryTitle, entryHint, createEntry, listEntries, getSummary, getWeekSummary, displayTitle, todayForUser };
