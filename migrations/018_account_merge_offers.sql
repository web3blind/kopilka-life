-- One-time, session-bound offers issued only after provider verification.
ALTER TABLE google_oauth_intents ADD COLUMN session_hash TEXT;
ALTER TABLE google_oauth_states ADD COLUMN session_hash TEXT;
ALTER TABLE email_login_codes ADD COLUMN session_hash TEXT;
CREATE TABLE account_merge_offers (
  token_hash TEXT PRIMARY KEY,
  current_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('email','google','telegram')),
  subject TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(current_user_id != other_user_id)
);
CREATE INDEX idx_account_merge_offers_expiry ON account_merge_offers(expires_at);
CREATE TABLE telegram_link_proofs (
  proof_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_telegram_link_proofs_expiry ON telegram_link_proofs(expires_at);
CREATE TABLE merged_ref_codes (
  ref_code TEXT PRIMARY KEY COLLATE NOCASE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
