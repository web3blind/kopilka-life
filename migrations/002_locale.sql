-- Add locale column for existing databases (i18n RU/EN).
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'ru';
