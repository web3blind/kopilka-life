-- Cross-context Telegram proof: opaque launch nonce alone never authorizes a link.
CREATE TABLE telegram_link_intents (
  intent_hash TEXT PRIMARY KEY,
  current_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  telegram_id TEXT,
  proof_hash TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_telegram_link_intents_expiry ON telegram_link_intents(expires_at);
