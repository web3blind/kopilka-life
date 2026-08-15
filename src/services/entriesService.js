const { getDb } = require('../db');
const { localDateString, weekStartDateString } = require('../time');

const ENTRY_TYPES = { sleep: ['Нормальный сон', 3], movement: ['Движение', 2], food_water: ['Еда или вода', 1], joy: ['Радость', 1], gratitude: ['Благодарность', 1], important_task: ['Важное дело', 2], dream_step: ['Шаг к мечте', 2], kind_trace: ['Доброе дело', 1], honest_step: ['Честный шаг', 2], rest: ['Отдых', 1], hard_day: ['Сложный день', 1] };
function getUserTimezone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }
function todayForUser(userId, now = new Date()) { return localDateString(now, getUserTimezone(userId)); }
function createEntry(userId, type, note = '') {
  const config = ENTRY_TYPES[type];
  if (!config) throw new Error('Неизвестный тип записи');
  const info = getDb().prepare('INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, ?, ?, ?, ?, ?)').run(userId, type, config[0], note.slice(0, 500), config[1], todayForUser(userId));
  return getDb().prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
}
function listEntries(userId, range = 'week') {
  const db = getDb();
  if (range === 'today') return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date = ? ORDER BY created_at DESC, id DESC').all(userId, todayForUser(userId));
  const since = weekStartDateString(new Date(), getUserTimezone(userId));
  return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date >= ? ORDER BY entry_date DESC, created_at DESC, id DESC').all(userId, since);
}
function getSummary(userId) {
  const db = getDb();
  const today = todayForUser(userId);
  return { totalLife: db.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(userId).total, todayLife: db.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ? AND entry_date = ?').get(userId, today).total, todayEntries: listEntries(userId, 'today').slice(0, 3) };
}
function getWeekSummary(userId) {
  const entries = listEntries(userId, 'week');
  const days = new Map();
  const categories = new Map();
  entries.forEach((entry) => { const item = days.get(entry.entry_date) || { date: entry.entry_date, life: 0, titles: [] }; item.life += entry.life_points; if (!item.titles.includes(entry.title)) item.titles.push(entry.title); days.set(entry.entry_date, item); categories.set(entry.title, (categories.get(entry.title) || 0) + 1); });
  return { weekLife: entries.reduce((sum, entry) => sum + entry.life_points, 0), activeDays: days.size, days: Array.from(days.values()).sort((a, b) => b.date.localeCompare(a.date)), topCategories: Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, count]) => ({ title, count })), entries };
}
module.exports = { ENTRY_TYPES, createEntry, listEntries, getSummary, getWeekSummary, todayForUser };
