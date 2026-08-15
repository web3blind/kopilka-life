const { getDb } = require('../db');
const { normalizeHHMM, normalizeTimezone } = require('../time');
const { normalizeLocale } = require('../i18n');

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, firstName: user.first_name, username: user.username, timezone: user.timezone, locale: normalizeLocale(user.locale), remindersEnabled: Boolean(user.reminders_enabled), eveningReminderTime: user.evening_reminder_time, isDemo: Boolean(user.is_demo) };
}
function upsertTelegramUser(tgUser) {
  const db = getDb();
  const telegramId = String(tgUser.id);
  const locale = normalizeLocale(tgUser.language_code);
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (existing) {
    db.prepare('UPDATE users SET first_name = ?, username = ?, locale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tgUser.first_name || '', tgUser.username || '', locale, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const info = db.prepare("INSERT INTO users (telegram_id, first_name, username, timezone, locale, reminders_enabled, is_demo) VALUES (?, ?, ?, 'Asia/Novosibirsk', ?, 0, 0)").run(telegramId, tgUser.first_name || '', tgUser.username || '', locale);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function createDemoUser(name = 'Demo', locale = 'ru') {
  const db = getDb();
  const telegramId = `demo:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const info = db.prepare("INSERT INTO users (telegram_id, first_name, username, timezone, locale, reminders_enabled, is_demo) VALUES (?, ?, 'demo_user', 'Asia/Novosibirsk', ?, 0, 1)").run(telegramId, String(name).slice(0, 60), normalizeLocale(locale));
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function getUserById(id) { return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id); }
function updateLocale(userId, locale) {
  const normalized = normalizeLocale(locale);
  getDb().prepare('UPDATE users SET locale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized, userId);
  return getUserById(userId);
}
function updateSettings(userId, settings) {
  const timezone = normalizeTimezone(settings.timezone || 'Asia/Novosibirsk');
  const reminderTime = normalizeHHMM(settings.eveningReminderTime || settings.evening_reminder_time || '20:00');
  getDb().prepare('UPDATE users SET timezone = ?, evening_reminder_time = ?, reminders_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(timezone, reminderTime, settings.remindersEnabled ? 1 : 0, userId);
  return getUserById(userId);
}
function deleteDemoUser(userId) {
  const user = getUserById(userId);
  if (!user || !user.is_demo) return false;
  getDb().prepare('DELETE FROM users WHERE id = ? AND is_demo = 1').run(userId);
  return true;
}
module.exports = { publicUser, upsertTelegramUser, createDemoUser, getUserById, updateLocale, updateSettings, deleteDemoUser };
