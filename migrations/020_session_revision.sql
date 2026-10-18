-- Legacy signed sessions have implicit revision 0; a merge revokes both sides.
ALTER TABLE users ADD COLUMN session_revision INTEGER NOT NULL DEFAULT 0;
-- Retain independent historical actions even when two accounts used the same day/type.
-- createEntry still enforces the ordinary single-account quick-action rule.
DROP INDEX IF EXISTS idx_entries_user_date_type_once;
