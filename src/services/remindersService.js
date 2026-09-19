const { getDb } = require('../db');
const { sendReminder } = require('../telegram');
const { sendVkReminder } = require('../vkMessages');
const { nextDueAt: computeNextDueAt, normalizeHHMM, normalizeTimezone, localDateString } = require('../time');
const { normalizeLocale, t } = require('../i18n');

function hasDeliveryChannel(user) {
  const telegramId = String(user.telegram_id || '');
  return Boolean((telegramId && !telegramId.startsWith('vk:')) || (user.vk_id && user.vk_messages_allowed));
}
function isPermanentDeliveryError(error) {
  const code = Number(error && error.code);
  return isVkPermissionError(error) || [5, 7, 15, 100, 113, 200, 400, 401, 403, 404].includes(code) ||
    /Telegram API error:\s*(400|401|403|404)\b/.test(String(error && error.message));
}

function isVkPermissionError(error) {
  const code = Number(error && error.code);
  const message = error && error.message ? String(error.message) : String(error || '');
  return [901, 917].includes(code) || /VK API error:\s*(901|917)\b/.test(message);
}

function markVkMessagesDenied(userId, reason) {
  getDb().prepare('UPDATE users SET vk_messages_allowed = 0, vk_messages_allowed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  console.error('VK reminder permission revoked:', reason || 'messages.send permission error');
}

function nextDueAt(timeHHMM, timezone = 'UTC', now = new Date()) {
  return computeNextDueAt(timeHHMM, timezone, now);
}

function getExistingScheduledReminder(userId) {
  return getDb().prepare("SELECT * FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL ORDER BY due_at ASC LIMIT 1").get(userId);
}

function clearScheduledRemindersForUser(userId) {
  return getDb().prepare("DELETE FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL").run(userId).changes;
}

function scheduleNextReminderForUser(userId, options = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.reminders_enabled || !hasDeliveryChannel(user)) {
    clearScheduledRemindersForUser(userId);
    return null;
  }
  if (options.replace) clearScheduledRemindersForUser(userId);
  const existing = getExistingScheduledReminder(userId);
  if (existing) return existing;
  const timezone = normalizeTimezone(user.timezone);
  const time = normalizeHHMM(user.evening_reminder_time);
  const dueAt = nextDueAt(time, timezone);
  db.prepare("INSERT OR IGNORE INTO reminders (user_id, type, due_at, status) VALUES (?, 'evening', ?, 'scheduled')").run(userId, dueAt);
  return db.prepare('SELECT * FROM reminders WHERE user_id = ? AND due_at = ?').get(userId, dueAt);
}

function scheduleRemindersForEnabledUsers() {
  const users = getDb().prepare('SELECT id FROM users WHERE reminders_enabled = 1').all();
  users.forEach((user) => scheduleNextReminderForUser(user.id));
  return users.length;
}

function contractReminderText(userId, locale, now = new Date()) {
  const db = getDb();
  const user = db.prepare('SELECT timezone, locale FROM users WHERE id = ?').get(userId);
  if (!user) return '';
  const today = localDateString(now, normalizeTimezone(user.timezone));
  const contract = db.prepare("SELECT id FROM weekly_contracts WHERE user_id = ? AND status = 'active' AND week_end <= ? ORDER BY created_at DESC LIMIT 1").get(userId, today);
  return contract ? t(normalizeLocale(locale || user.locale), 'reminder.contractLastDay') : '';
}

// Startup only, while no tick owns delivery. A crash may follow provider acceptance:
// do not blindly resend (Telegram has no idempotency key). Retire the uncertain
// attempt; normal scheduling resumes with the next future reminder.
function recoverInterruptedReminders() {
  return getDb().prepare("UPDATE reminders SET status = 'failed', retry_after = NULL WHERE status = 'sending' AND sent_at IS NULL").run().changes;
}

async function sendDueReminders(limit = 20) {
  const db = getDb();
  const due = db.prepare("SELECT r.*, u.telegram_id, u.vk_id, u.vk_messages_allowed, u.locale FROM reminders r JOIN users u ON u.id = r.user_id WHERE r.status = 'scheduled' AND r.sent_at IS NULL AND r.due_at <= ? AND (r.retry_after IS NULL OR r.retry_after <= ?) ORDER BY r.due_at ASC LIMIT ?").all(new Date().toISOString(), new Date().toISOString(), limit);
  let sent = 0;
  for (const reminder of due) {
    if (db.prepare("UPDATE reminders SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND sent_at IS NULL AND status = 'scheduled'").run(reminder.id).changes !== 1) continue;
    try {
      const telegramId = String(reminder.telegram_id || '');
      const channels = [];
      const extraText = contractReminderText(reminder.user_id, reminder.locale);
      if (telegramId.startsWith('demo:')) channels.push({ name: 'demo', send: async () => {} });
      if (telegramId && !telegramId.startsWith('vk:')) channels.push({ name: 'telegram', send: () => sendReminder(telegramId, reminder.locale, extraText) });
      if (reminder.vk_id && reminder.vk_messages_allowed) channels.push({ name: 'vk', send: () => sendVkReminder(reminder.vk_id, reminder.locale, extraText, `reminder:${reminder.id}:${reminder.due_at}`) });
      if (!channels.length) throw Object.assign(new Error('No reminder delivery channel is available'), { permanent: true });

      let delivered = 0;
      let temporaryFailure = false;
      let uncertainDelivery = false;
      const errors = [];
      for (const channel of channels) {
        try {
          await channel.send();
          delivered += 1;
        } catch (channelError) {
          // Telegram offers no deduplication key: retry only an explicit provider
          // rejection, not a timeout/network failure that may follow acceptance.
          const ambiguousTelegram = channel.name === 'telegram' && !/^Telegram API error: \d+$/.test(String(channelError.message));
          if (ambiguousTelegram) uncertainDelivery = true;
          if (!ambiguousTelegram && !isPermanentDeliveryError(channelError)) temporaryFailure = true;
          if (channel.name === 'vk' && isVkPermissionError(channelError)) {
            markVkMessagesDenied(reminder.user_id, channelError.message);
          }
          errors.push(`${channel.name}: ${channelError.message}`);
        }
      }
      if (!delivered) throw Object.assign(new Error(errors.join('; ') || 'All reminder delivery channels failed'), { permanent: uncertainDelivery || !temporaryFailure });
      if (errors.length) console.error('Reminder partial delivery error:', errors.join('; '));
      db.prepare("UPDATE reminders SET sent_at = CURRENT_TIMESTAMP, status = 'sent' WHERE id = ?").run(reminder.id);
      scheduleNextReminderForUser(reminder.user_id);
      sent += 1;
    } catch (error) {
      console.error('Reminder send error:', error.message);
      const attempts = reminder.attempts + 1;
      const retry = !error.permanent && attempts < 3;
      const retryAfter = retry ? new Date(Date.now() + (attempts === 1 ? 60000 : 300000)).toISOString() : null;
      db.prepare("UPDATE reminders SET status = ?, retry_after = ? WHERE id = ? AND sent_at IS NULL")
        .run(retry ? 'scheduled' : 'failed', retryAfter, reminder.id);
      if (!retry) scheduleNextReminderForUser(reminder.user_id);
    }
  }
  return sent;
}

module.exports = { recoverInterruptedReminders, nextDueAt, scheduleNextReminderForUser, scheduleRemindersForEnabledUsers, sendDueReminders, clearScheduledRemindersForUser, contractReminderText, isVkPermissionError, markVkMessagesDenied };
