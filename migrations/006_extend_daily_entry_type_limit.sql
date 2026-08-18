-- Extend the one-quick-action-per-local-day guard to new social connection types.
DROP INDEX IF EXISTS idx_entries_user_date_type_once;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_user_date_type_once
ON entries(user_id, entry_date, type)
WHERE type IN ('sleep', 'movement', 'food_water', 'joy', 'gratitude', 'important_task', 'dream_step', 'kind_trace', 'honest_step', 'social_contact', 'family_time', 'rest', 'hard_day');
