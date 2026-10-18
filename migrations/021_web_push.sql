-- Additive per-device subscriptions and durable per-channel deliveries.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  session_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE reminder_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('telegram','vk','demo','push')),
  subscription_id INTEGER REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT,
  sent_at TEXT,
  UNIQUE(reminder_id, recipient_key)
);
CREATE INDEX idx_reminder_deliveries_pending ON reminder_deliveries(status, retry_after, reminder_id);
