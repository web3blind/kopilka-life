-- Project-wide attempted Gemini requests: deliberately no user/key/model FK.
-- Deleting or merging an account must never refund provider capacity.
CREATE TABLE IF NOT EXISTS ai_provider_quota (
  id INTEGER PRIMARY KEY,
  reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
  input_bound INTEGER NOT NULL CHECK(input_bound > 0)
);
CREATE INDEX IF NOT EXISTS ai_provider_quota_reserved_at ON ai_provider_quota(reserved_at);
