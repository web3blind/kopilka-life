const { getDb } = require('../db');
const { sendReminder } = require('../telegram');
const { sendVkReminder } = require('../vkMessages');
const push = require('./pushService');
const { nextDueAt: computeNextDueAt, normalizeHHMM, normalizeTimezone, localDateString } = require('../time');
const { normalizeLocale, t } = require('../i18n');

function hasDeliveryChannel(user) {
  const id = String(user.telegram_id || '');
  return Boolean((id && !/^(vk:|email:|google:)/.test(id)) || (user.vk_id && user.vk_messages_allowed) ||
    getDb().prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND session_revision = ? LIMIT 1').get(user.id, user.session_revision));
}
function isVkPermissionError(error) {
  const code = Number(error?.code);
  return [901, 917].includes(code) || /VK API error:\s*(901|917)\b/.test(String(error?.message || ''));
}
function isPermanentDeliveryError(error) {
  const code = Number(error?.code);
  return Boolean(error?.permanent) || isVkPermissionError(error) || [5, 7, 15, 100, 113, 200, 400, 401, 403, 404].includes(code) ||
    /Telegram API error:\s*(400|401|403|404)\b/.test(String(error?.message || ''));
}
function markVkMessagesDenied(userId) {
  getDb().prepare('UPDATE users SET vk_messages_allowed = 0, vk_messages_allowed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  console.error('VK reminder permission revoked');
}
function nextDueAt(timeHHMM, timezone = 'UTC', now = new Date()) { return computeNextDueAt(timeHHMM, timezone, now); }
function clearScheduledRemindersForUser(userId) {
  return getDb().prepare("DELETE FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL").run(userId).changes;
}
function scheduleNextReminderForUser(userId, options = {}) {
  const db = getDb(), user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.reminders_enabled || !hasDeliveryChannel(user)) {
    db.prepare("DELETE FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL AND due_at > ?")
      .run(userId, new Date().toISOString());
    return null;
  }
  if (options.replace) db.prepare("DELETE FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL AND due_at > ?")
    .run(userId, new Date().toISOString());
  const existing = db.prepare("SELECT * FROM reminders WHERE user_id = ? AND type = 'evening' AND status = 'scheduled' AND sent_at IS NULL ORDER BY due_at LIMIT 1").get(userId);
  if (existing) return existing;
  const dueAt = nextDueAt(normalizeHHMM(user.evening_reminder_time), normalizeTimezone(user.timezone));
  db.prepare("INSERT OR IGNORE INTO reminders (user_id, type, due_at, status) VALUES (?, 'evening', ?, 'scheduled')").run(userId, dueAt);
  return db.prepare('SELECT * FROM reminders WHERE user_id = ? AND due_at = ?').get(userId, dueAt);
}
function scheduleRemindersForEnabledUsers() {
  const users = getDb().prepare('SELECT id FROM users WHERE reminders_enabled = 1').all();
  users.forEach(user => scheduleNextReminderForUser(user.id)); return users.length;
}
function contractReminderText(userId, locale, now = new Date()) {
  const db = getDb(), user = db.prepare('SELECT timezone, locale FROM users WHERE id = ?').get(userId);
  if (!user) return '';
  const today = localDateString(now, normalizeTimezone(user.timezone));
  const contract = db.prepare("SELECT id FROM weekly_contracts WHERE user_id = ? AND status = 'active' AND week_end <= ? ORDER BY created_at DESC LIMIT 1").get(userId, today);
  return contract ? t(normalizeLocale(locale || user.locale), 'reminder.contractLastDay') : '';
}
// An interrupted in-flight send may already have been accepted: never replay it.
function recoverInterruptedReminders() {
  const db = getDb();
  db.prepare("UPDATE reminder_deliveries SET status = 'failed', retry_after = NULL WHERE status = 'sending'").run();
  const rows = db.prepare("SELECT id,user_id FROM reminders WHERE status = 'sending' AND sent_at IS NULL").all();
  for (const row of rows) {
    const pending = db.prepare("SELECT COUNT(*) AS n, MIN(retry_after) AS next FROM reminder_deliveries WHERE reminder_id = ? AND status = 'scheduled'").get(row.id);
    if (pending.n) db.prepare("UPDATE reminders SET status = 'scheduled', retry_after = ? WHERE id = ?").run(pending.next, row.id);
    else {
      const success = db.prepare("SELECT COUNT(*) AS n FROM reminder_deliveries WHERE reminder_id = ? AND status = 'sent'").get(row.id).n;
      db.prepare("UPDATE reminders SET status = ?, sent_at = ?, retry_after = NULL WHERE id = ?")
        .run(success ? 'sent' : 'failed', success ? new Date().toISOString() : null, row.id);
      scheduleNextReminderForUser(row.user_id);
    }
  }
  return rows.length;
}
function seedDeliveries(db, reminder) {
  const add = db.prepare('INSERT OR IGNORE INTO reminder_deliveries (reminder_id,channel,subscription_id,recipient_key) VALUES (?,?,?,?)');
  const tg = String(reminder.telegram_id || '');
  if (tg.startsWith('demo:')) add.run(reminder.id, 'demo', null, 'demo');
  else if (tg && !/^(vk:|email:|google:)/.test(tg)) add.run(reminder.id, 'telegram', null, `telegram:${tg}`);
  if (reminder.vk_id && reminder.vk_messages_allowed) add.run(reminder.id, 'vk', null, `vk:${reminder.vk_id}`);
  for (const sub of db.prepare(`SELECT s.id FROM push_subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.session_revision = u.session_revision`).all(reminder.user_id))
    add.run(reminder.id, 'push', sub.id, `push:${sub.id}`);
}
function finishReminder(db, reminder, delivered) {
  const pending = db.prepare("SELECT COUNT(*) AS n, MIN(retry_after) AS next FROM reminder_deliveries WHERE reminder_id = ? AND status = 'scheduled'").get(reminder.id);
  if (pending.n) db.prepare("UPDATE reminders SET status = 'scheduled', retry_after = ? WHERE id = ?").run(pending.next, reminder.id);
  else {
    const success = db.prepare("SELECT COUNT(*) AS n FROM reminder_deliveries WHERE reminder_id = ? AND status = 'sent'").get(reminder.id).n;
    db.prepare('UPDATE reminders SET status = ?, sent_at = ?, retry_after = NULL WHERE id = ?')
      .run(success ? 'sent' : 'failed', success ? new Date().toISOString() : null, reminder.id);
    scheduleNextReminderForUser(reminder.user_id);
  }
  return delivered > 0 ? 1 : 0;
}
async function sendDueReminders(limit = 20) {
  const db = getDb(), now = new Date().toISOString();
  const due = db.prepare(`SELECT r.*,u.telegram_id,u.vk_id,u.vk_messages_allowed,u.locale FROM reminders r
    JOIN users u ON u.id = r.user_id WHERE r.status = 'scheduled' AND r.sent_at IS NULL
    AND r.due_at <= ? AND (r.retry_after IS NULL OR r.retry_after <= ?) ORDER BY r.due_at LIMIT ?`).all(now, now, limit);
  let sent = 0;
  for (const reminder of due) {
    if (db.prepare("UPDATE reminders SET status = 'sending',attempts = attempts + 1 WHERE id = ? AND status = 'scheduled' AND sent_at IS NULL")
      .run(reminder.id).changes !== 1) continue;
    let delivered = 0;
    try {
      if (reminder.attempts === 0) seedDeliveries(db, reminder);
      const deliveries = db.prepare(`SELECT d.*,s.endpoint,s.p256dh,s.auth,s.user_id AS subscription_user_id,s.session_revision,
        u.session_revision AS current_revision FROM reminder_deliveries d
        LEFT JOIN push_subscriptions s ON s.id = d.subscription_id JOIN users u ON u.id = ?
        WHERE d.reminder_id = ? AND d.status = 'scheduled' AND (d.retry_after IS NULL OR d.retry_after <= ?) ORDER BY d.id`)
        .all(reminder.user_id, reminder.id, now);
      const text = contractReminderText(reminder.user_id, reminder.locale);
      for (const delivery of deliveries) {
        if (db.prepare("UPDATE reminder_deliveries SET status = 'sending',attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'").run(delivery.id).changes !== 1) continue;
        try {
          if (delivery.channel === 'telegram') {
            if (`telegram:${String(reminder.telegram_id || '')}` !== delivery.recipient_key) throw Object.assign(new Error('Telegram identity changed'), { permanent: true });
            await sendReminder(reminder.telegram_id, reminder.locale, text);
          } else if (delivery.channel === 'vk') {
            if (!reminder.vk_messages_allowed || `vk:${String(reminder.vk_id || '')}` !== delivery.recipient_key)
              throw Object.assign(new Error('VK permission or identity changed'), { permanent: true });
            await sendVkReminder(reminder.vk_id, reminder.locale, text, `reminder:${reminder.id}:${reminder.due_at}`);
          } else if (delivery.channel === 'push') {
            if (!delivery.endpoint || delivery.subscription_user_id !== reminder.user_id || delivery.session_revision !== delivery.current_revision)
              throw Object.assign(new Error('Subscription no longer belongs to account'), { statusCode: 410 });
            await push.sendPush(delivery, reminder.locale, text);
          }
          db.prepare("UPDATE reminder_deliveries SET status = 'sent',sent_at = CURRENT_TIMESTAMP,retry_after = NULL WHERE id = ?").run(delivery.id);
          delivered++;
        } catch (error) {
          const status = Number(error?.statusCode);
          const expired = delivery.channel === 'push' && [404, 410].includes(status);
          if (expired && delivery.subscription_id) db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(delivery.subscription_id, reminder.user_id);
          if (delivery.channel === 'vk' && isVkPermissionError(error)) markVkMessagesDenied(reminder.user_id);
          const ambiguous = (delivery.channel === 'telegram' && !/^Telegram API error: \d+$/.test(String(error?.message))) ||
            (delivery.channel === 'push' && !status);
          const permanent = expired || ambiguous || (delivery.channel === 'push' ? [400, 401, 403].includes(status) : isPermanentDeliveryError(error));
          const retry = !permanent && delivery.attempts + 1 < 3;
          const after = retry ? new Date(Date.now() + (delivery.attempts ? 300000 : 60000)).toISOString() : null;
          db.prepare('UPDATE reminder_deliveries SET status = ?,retry_after = ? WHERE id = ?')
            .run(retry ? 'scheduled' : 'failed', after, delivery.id);
          console.error('Reminder channel failure:', delivery.channel, retry ? 'retry scheduled' : 'retired');
        }
      }
      sent += finishReminder(db, reminder, delivered);
    } catch (_) {
      db.prepare("UPDATE reminders SET status = 'failed',retry_after = NULL WHERE id = ?").run(reminder.id);
      scheduleNextReminderForUser(reminder.user_id);
      console.error('Reminder processing failed');
    }
  }
  return sent;
}
module.exports = { recoverInterruptedReminders, nextDueAt, scheduleNextReminderForUser, scheduleRemindersForEnabledUsers, sendDueReminders, clearScheduledRemindersForUser, contractReminderText, isVkPermissionError, markVkMessagesDenied };
