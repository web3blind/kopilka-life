CREATE TABLE ai_weekly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  period_key TEXT NOT NULL,
  locale TEXT NOT NULL CHECK(locale IN ('ru','en')),
  status TEXT NOT NULL CHECK(status IN ('processing','ready','failed','uncertain','deleted')),
  text TEXT,
  error_code TEXT,
  provider TEXT NOT NULL DEFAULT 'OpenRouter',
  model TEXT NOT NULL,
  generation_version TEXT NOT NULL DEFAULT '1',
  consent_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
-- Not UNIQUE: independent saved summaries for equal periods survive account merges.
-- The service's synchronous transaction claims a period before any awaited work.
CREATE INDEX ai_weekly_owner_period ON ai_weekly_summaries(user_id,period_start,period_end,id);
