ALTER TABLE ai_weekly_summaries ADD COLUMN topic TEXT NOT NULL DEFAULT 'summary'
  CHECK(topic IN ('summary','calm','hard-days','rest','kindness','self-support','goal'));
ALTER TABLE ai_weekly_summaries ADD COLUMN days INTEGER NOT NULL DEFAULT 7 CHECK(days BETWEEN 1 AND 30);
-- Include every outcome and legacy claim: deleting text must not reset the rolling quota.
CREATE INDEX ai_assistant_owner_claim ON ai_weekly_summaries(user_id,started_at DESC,id DESC);
