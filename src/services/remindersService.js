const { getDb } = require('../db');
const { sendReminder } = require('../telegram');
const { nextDueAt: computeNextDueAt, normalizeHHMM, normalizeTimezone } = require('../time');

function nextDueAt(timeHHMM, timezone = 'UTC', now = new Date()) {
  return computeNextDueAt(timeHHMM, timezone, now);
}

function getExistingScheduledReminder(userId) {
  return getDb().prepare("SELECT * FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL AND due_at > ? ORDER BY due_at ASC LIMIT 1").get(userId, new Date().toISOString());
}

function clearScheduledRemindersForUser(userId) {
  return getDb().prepare("DELETE FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL").run(userId).changes;
}

function scheduleNextReminderForUser(userId, options = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.reminders_enabled) {
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

async function sendDueReminders(limit = 20) {
  const db = getDb();
  const due = db.prepare("SELECT r.*, u.telegram_id FROM reminders r JOIN users u ON u.id = r.user_id WHERE r.status = 'scheduled' AND r.sent_at IS NULL AND r.due_at <= ? ORDER BY r.due_at ASC LIMIT ?").all(new Date().toISOString(), limit);
  let sent = 0;
  for (const reminder of due) {
    if (db.prepare("UPDATE reminders SET status = 'sending' WHERE id = ? AND sent_at IS NULL AND status = 'scheduled'").run(reminder.id).changes !== 1) continue;
    try {
      if (!String(reminder.telegram_id || '').startsWith('demo:')) await sendReminder(reminder.telegram_id);
      db.prepare("UPDATE reminders SET sent_at = CURRENT_TIMESTAMP, status = 'sent' WHERE id = ?").run(reminder.id);
      scheduleNextReminderForUser(reminder.user_id);
      sent += 1;
    } catch (error) {
      console.error('Reminder send error:', error.message);
      db.prepare("UPDATE reminders SET status = 'scheduled' WHERE id = ? AND sent_at IS NULL").run(reminder.id);
    }
  }
  return sent;
}

module.exports = { nextDueAt, scheduleNextReminderForUser, scheduleRemindersForEnabledUsers, sendDueReminders, clearScheduledRemindersForUser };
