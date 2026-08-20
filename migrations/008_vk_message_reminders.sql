-- VK community message opt-in for evening reminders.
ALTER TABLE users ADD COLUMN vk_messages_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN vk_messages_allowed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_vk_messages_allowed ON users(vk_messages_allowed, vk_id);
