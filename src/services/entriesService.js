const { getDb } = require('../db');
const { localDateString, weekStartDateString } = require('../time');
const { normalizeLocale, t } = require('../i18n');
const { sanitizeText } = require('../utils/sanitize');
const ENTRY_NOTE_MAX_LENGTH = 2000;

// Life points per entry type. Titles/hints are localized via i18n by type key.
const ENTRY_TYPES = ['sleep', 'movement', 'food_water', 'joy', 'savoring', 'gratitude', 'important_task', 'dream_step', 'dreamed', 'kind_trace', 'gifted_joy', 'honest_step', 'social_contact', 'family_time', 'rest', 'hard_day'];
const ENTRY_POINTS = { sleep: 3, movement: 2, food_water: 1, joy: 1, savoring: 1, gratitude: 1, important_task: 2, dream_step: 2, dreamed: 1, kind_trace: 2, gifted_joy: 2, honest_step: 2, social_contact: 2, family_time: 2, rest: 1, hard_day: 1 };

function entryTitle(type, locale) {
  return t(locale, `entry.${type}.title`);
}
function entryHint(type, locale) {
  return t(locale, `entry.${type}.hint`);
}
function getUserTimezone(userId) { return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk'; }
function getUserLocale(userId) { return normalizeLocale(getDb().prepare('SELECT locale FROM users WHERE id = ?').get(userId)?.locale); }
function todayForUser(userId, now = new Date()) { return localDateString(now, getUserTimezone(userId)); }
function sanitizeEntryNote(note) {
  const cleanNote = sanitizeText(note, { maxLength: null });
  if (cleanNote.length > ENTRY_NOTE_MAX_LENGTH) throw new Error('error.entryNoteTooLong');
  return cleanNote;
}
function createEntry(userId, type, note = '', locale) {
  if (!ENTRY_POINTS[type]) throw new Error('error.unknownType');
  const db = getDb();
  const lang = normalizeLocale(locale || getUserLocale(userId));
  const cleanNote = sanitizeEntryNote(note);
  const today = todayForUser(userId);
  const existing = db.prepare('SELECT id FROM entries WHERE user_id = ? AND entry_date = ? AND type = ?').get(userId, today, type);
  if (existing) throw new Error('error.entryAlreadyToday');
  try {
    const info = db.prepare('INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, ?, ?, ?, ?, ?)').run(userId, type, entryTitle(type, lang), cleanNote, ENTRY_POINTS[type], today);
    return db.prepare('SELECT * FROM entries WHERE id = ?').get(info.lastInsertRowid);
  } catch (error) {
    if (error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error('error.entryAlreadyToday');
    throw error;
  }
}
function listEntries(userId, range = 'week') {
  const db = getDb();
  if (range === 'today') return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date = ? ORDER BY created_at DESC, id DESC').all(userId, todayForUser(userId));
  const since = weekStartDateString(new Date(), getUserTimezone(userId));
  return db.prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date >= ? ORDER BY entry_date DESC, created_at DESC, id DESC').all(userId, since);
}
function validDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function addDateDays(value, amount) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function editableEntry(entry) {
  return ENTRY_TYPES.includes(entry.type);
}
function getHistory(userId, { date, days = 7 } = {}) {
  const selectedDate = String(date || todayForUser(userId));
  const pageDays = Number(days);
  if (!validDateString(selectedDate)) throw new Error('error.historyDate');
  if (!Number.isInteger(pageDays) || pageDays < 1 || pageDays > 31) throw new Error('error.historyDays');
  const today = todayForUser(userId);
  if (selectedDate > today) throw new Error('error.historyFuture');
  const startDate = addDateDays(selectedDate, -(pageDays - 1));
  const rows = getDb().prepare('SELECT * FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, created_at DESC, id DESC LIMIT 500').all(userId, startDate, selectedDate);
  const lang = getUserLocale(userId);
  const entries = rows.map((entry) => ({ ...entry, title: displayTitle(entry, lang), editable: editableEntry(entry) }));
  const byDate = new Map();
  entries.forEach((entry) => {
    const day = byDate.get(entry.entry_date) || { date: entry.entry_date, life: 0, entryCount: 0, titles: [] };
    day.life += entry.life_points;
    day.entryCount += 1;
    if (!day.titles.includes(entry.title)) day.titles.push(entry.title);
    byDate.set(entry.entry_date, day);
  });
  const historyDays = [];
  for (let offset = 0; offset < pageDays; offset += 1) {
    const day = addDateDays(selectedDate, -offset);
    historyDays.push(byDate.get(day) || { date: day, life: 0, entryCount: 0, titles: [] });
  }
  const hasOlder = Boolean(getDb().prepare('SELECT 1 FROM entries WHERE user_id = ? AND entry_date < ? LIMIT 1').get(userId, startDate));
  return {
    todayDate: today,
    selectedDate,
    selectedEntries: entries.filter((entry) => entry.entry_date === selectedDate),
    days: historyDays,
    previousDate: addDateDays(selectedDate, -1),
    nextDate: selectedDate < today ? addDateDays(selectedDate, 1) : null,
    hasOlder,
    truncated: rows.length === 500
  };
}
function ownedEditableEntry(userId, entryId) {
  const id = Number(entryId);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('error.entryNotFound');
    error.status = 404;
    throw error;
  }
  const entry = getDb().prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(id, userId);
  if (!entry) {
    const error = new Error('error.entryNotFound');
    error.status = 404;
    throw error;
  }
  if (!editableEntry(entry)) throw new Error('error.entryProtected');
  return entry;
}
function updateEntryNote(userId, entryId, note) {
  const db = getDb();
  const cleanNote = sanitizeEntryNote(note);
  return db.transaction(() => {
    const entry = ownedEditableEntry(userId, entryId);
    db.prepare('UPDATE entries SET note = ? WHERE id = ? AND user_id = ?').run(cleanNote, entry.id, userId);
    return { ...db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').get(entry.id, userId), editable: true };
  })();
}
function deleteEntry(userId, entryId) {
  const db = getDb();
  return db.transaction(() => {
    const entry = ownedEditableEntry(userId, entryId);
    db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').run(entry.id, userId);
    return entry;
  })();
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
module.exports = { ENTRY_TYPES, ENTRY_POINTS, ENTRY_NOTE_MAX_LENGTH, entryTitle, entryHint, createEntry, listEntries, getHistory, updateEntryNote, deleteEntry, getSummary, getWeekSummary, displayTitle, todayForUser, validDateString };
