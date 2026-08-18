-- Path artifacts: gentle collectible encounters awarded for life milestones and specific care patterns.
CREATE TABLE IF NOT EXISTS user_artifacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  trigger_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  awarded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_user_artifacts_user_awarded ON user_artifacts(user_id, awarded_at DESC);
