CREATE TABLE google_oauth_intents (
  intent_hash TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ref_code TEXT,
  timezone TEXT,
  locale TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_google_oauth_intents_expiry ON google_oauth_intents(expires_at);
ALTER TABLE google_oauth_states ADD COLUMN handoff_channel TEXT;
