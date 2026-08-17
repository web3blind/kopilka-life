const crypto = require('crypto');
const { getDb } = require('../db');
const { normalizeHHMM, normalizeTimezone } = require('../time');
const { normalizeLocale } = require('../i18n');

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
function generateRefCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return code;
}
function ensureRefCode(userId) {
  const db = getDb();
  const user = db.prepare('SELECT ref_code FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  if (user.ref_code) return user.ref_code;
  // Try a few times to get a unique code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRefCode();
    try {
      db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, userId);
      return code;
    } catch (_) { /* unique collision; retry */ }
  }
  // Fallback: include id to guarantee uniqueness.
  const code = `${generateRefCode()}${userId.toString(36).toUpperCase().slice(0, 3)}`;
  db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, userId);
  return code;
}
function resolveRefCode(code) {
  if (!code || typeof code !== 'string') return null;
  return getDb().prepare('SELECT id FROM users WHERE ref_code = ? COLLATE NOCASE').get(String(code).trim().toUpperCase()) || null;
}
function publicUser(user) {
  if (!user) return null;
  return { id: user.id, firstName: user.first_name, username: user.username, timezone: user.timezone, locale: normalizeLocale(user.locale), remindersEnabled: Boolean(user.reminders_enabled), eveningReminderTime: user.evening_reminder_time, isDemo: Boolean(user.is_demo), vkLinked: Boolean(user.vk_id) };
}
function upsertTelegramUser(tgUser, refCode, timezone) {
  const db = getDb();
  const telegramId = String(tgUser.id);
  const locale = normalizeLocale(tgUser.language_code);
  const zone = normalizeTimezone(timezone || 'UTC');
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (existing) {
    ensureRefCode(existing.id);
    db.prepare('UPDATE users SET first_name = ?, username = ?, locale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(tgUser.first_name || '', tgUser.username || '', locale, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const referrer = resolveRefCode(refCode);
  const info = db.prepare("INSERT INTO users (telegram_id, first_name, username, timezone, locale, reminders_enabled, is_demo, referrer_id) VALUES (?, ?, ?, ?, ?, 0, 0, ?)").run(telegramId, tgUser.first_name || '', tgUser.username || '', zone, locale, referrer ? referrer.id : null);
  ensureRefCode(info.lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function createDemoUser(name = 'Demo', locale = 'ru', refCode, timezone) {
  const db = getDb();
  const telegramId = `demo:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const referrer = resolveRefCode(refCode);
  const zone = normalizeTimezone(timezone || 'UTC');
  const info = db.prepare("INSERT INTO users (telegram_id, first_name, username, timezone, locale, reminders_enabled, is_demo, referrer_id) VALUES (?, ?, 'demo_user', ?, ?, 0, 1, ?)").run(telegramId, String(name).slice(0, 60), zone, normalizeLocale(locale), referrer ? referrer.id : null);
  ensureRefCode(info.lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function upsertVkUser(vkId, refCode, timezone, locale = 'ru') {
  const db = getDb();
  const vkIdText = String(vkId);
  const existing = db.prepare('SELECT * FROM users WHERE vk_id = ?').get(vkIdText);
  if (existing) {
    ensureRefCode(existing.id);
    db.prepare('UPDATE users SET locale = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalizeLocale(locale), existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const referrer = resolveRefCode(refCode);
  const zone = normalizeTimezone(timezone || 'UTC');
  const info = db.prepare("INSERT INTO users (telegram_id, vk_id, first_name, username, timezone, locale, reminders_enabled, is_demo, referrer_id) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)")
    .run(`vk:${vkIdText}`, vkIdText, 'VK user', '', zone, normalizeLocale(locale), referrer ? referrer.id : null);
  ensureRefCode(info.lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
function userHasOwnedData(userId) {
  const db = getDb();
  const entries = db.prepare('SELECT COUNT(*) AS count FROM entries WHERE user_id = ?').get(userId).count;
  const contracts = db.prepare('SELECT COUNT(*) AS count FROM weekly_contracts WHERE user_id = ?').get(userId).count;
  const reminders = db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE user_id = ?').get(userId).count;
  return entries + contracts + reminders > 0;
}
function linkVkUser(userId, vkId) {
  const db = getDb();
  const vkIdText = String(vkId);
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!current) throw new Error('user not found');
  const linked = db.prepare('SELECT * FROM users WHERE vk_id = ?').get(vkIdText);
  const linkTransaction = db.transaction(() => {
    if (linked && linked.id !== userId) {
      const isDisposableVkOnly = String(linked.telegram_id || '').startsWith('vk:') && !userHasOwnedData(linked.id);
      if (!isDisposableVkOnly) throw new Error('Этот VK уже привязан к другому аккаунту. Войдите через VK отдельно или напишите поддержке.');
      db.prepare('DELETE FROM users WHERE id = ?').run(linked.id);
    }
    db.prepare('UPDATE users SET vk_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(vkIdText, userId);
  });
  linkTransaction();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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
module.exports = { publicUser, upsertTelegramUser, upsertVkUser, linkVkUser, createDemoUser, getUserById, updateLocale, updateSettings, deleteDemoUser, ensureRefCode, resolveRefCode };
