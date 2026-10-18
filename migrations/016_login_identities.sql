CREATE TABLE login_identities (
  provider TEXT NOT NULL CHECK (provider IN ('email', 'google')),
  subject TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX idx_login_identities_user_provider ON login_identities(user_id, provider);

CREATE TABLE email_login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_count INTEGER NOT NULL,
  requested_by INTEGER REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_email_login_codes_expiry ON email_login_codes(expires_at);
CREATE TABLE google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ref_code TEXT,
  timezone TEXT,
  locale TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_google_oauth_expiry ON google_oauth_states(expires_at);
