-- Bearers are never persisted. Expired rows may be pruned by a future bounded
-- maintenance job; authentication/logout do indexed lookups, never bulk cleanup.
CREATE TABLE session_revocations (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK(length(token_hash) = 64),
  expires_at INTEGER NOT NULL CHECK(expires_at > 0)
);
