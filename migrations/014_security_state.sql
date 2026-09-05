-- Security state for one-time VK OAuth handshakes and durable Telegram update deduplication.
CREATE TABLE IF NOT EXISTS vk_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  context_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vk_oauth_states_expiry ON vk_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS vk_oauth_intents (
  intent_hash TEXT PRIMARY KEY,
  context_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vk_oauth_intents_expiry ON vk_oauth_intents(expires_at);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('processing', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_updates_status_updated ON telegram_updates(status, updated_at);
