-- One quick-action entry of each type per user per local entry date.
-- System-generated entry types (weekly_contract, referral) are intentionally excluded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_user_date_type_once
ON entries(user_id, entry_date, type)
WHERE type IN ('sleep', 'movement', 'food_water', 'joy', 'gratitude', 'important_task', 'dream_step', 'kind_trace', 'honest_step', 'rest', 'hard_day');
