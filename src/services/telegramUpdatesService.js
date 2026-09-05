const { getDb } = require('../db');

const PROCESSING_LEASE_MS = 60 * 1000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 50000;

function normalizeUpdateId(updateId) {
  const value = Number(updateId);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Telegram update_id is invalid');
  return value;
}

function pruneUpdates(db, now) {
  db.prepare('DELETE FROM telegram_updates WHERE updated_at < ?').run(now - RETENTION_MS);
  const count = db.prepare('SELECT COUNT(*) AS count FROM telegram_updates').get().count;
  if (count > MAX_ROWS) {
    db.prepare("DELETE FROM telegram_updates WHERE update_id IN (SELECT update_id FROM telegram_updates WHERE status != 'processing' OR updated_at <= ? ORDER BY CASE status WHEN 'done' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, updated_at ASC LIMIT ?)").run(now - PROCESSING_LEASE_MS, count - MAX_ROWS);
  }
}

function claimUpdate(updateId, now = Date.now()) {
  const id = normalizeUpdateId(updateId);
  const db = getDb();
  return db.transaction(() => {
    pruneUpdates(db, now);
    const existing = db.prepare('SELECT * FROM telegram_updates WHERE update_id = ?').get(id);
    if (!existing) {
      db.prepare("INSERT INTO telegram_updates (update_id, status, attempts, created_at, updated_at) VALUES (?, 'processing', 1, ?, ?)").run(id, now, now);
      return { claimed: true, done: false, attempt: 1 };
    }
    if (existing.status === 'done') return { claimed: false, done: true, attempt: existing.attempts };
    if (existing.status === 'processing' && now - existing.updated_at < PROCESSING_LEASE_MS) {
      return { claimed: false, done: false, attempt: existing.attempts, retryAfterMs: PROCESSING_LEASE_MS - (now - existing.updated_at) };
    }
    db.prepare("UPDATE telegram_updates SET status = 'processing', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE update_id = ?").run(now, id);
    return { claimed: true, done: false, attempt: existing.attempts + 1 };
  })();
}

function normalizeAttempt(attempt) {
  const value = Number(attempt);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Telegram claim attempt is invalid');
  return value;
}

function markUpdateDone(updateId, attempt, now = Date.now()) {
  const info = getDb().prepare("UPDATE telegram_updates SET status = 'done', last_error = NULL, updated_at = ? WHERE update_id = ? AND attempts = ? AND status = 'processing'").run(now, normalizeUpdateId(updateId), normalizeAttempt(attempt));
  return info.changes === 1;
}

function markUpdateFailed(updateId, attempt, error, now = Date.now()) {
  const message = String(error || 'delivery failed').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  const info = getDb().prepare("UPDATE telegram_updates SET status = 'failed', last_error = ?, updated_at = ? WHERE update_id = ? AND attempts = ? AND status = 'processing'").run(message, now, normalizeUpdateId(updateId), normalizeAttempt(attempt));
  return info.changes === 1;
}

module.exports = { claimUpdate, markUpdateDone, markUpdateFailed, normalizeUpdateId, PROCESSING_LEASE_MS };
