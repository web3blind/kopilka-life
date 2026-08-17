-- VK identity linking for VK Mini App / VK ID.
ALTER TABLE users ADD COLUMN vk_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_vk_id ON users(vk_id);
