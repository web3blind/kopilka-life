-- Referral / partner program.
-- ref_code: user's own invite code (unique). referrer_id: who invited this user.
ALTER TABLE users ADD COLUMN ref_code TEXT;
ALTER TABLE users ADD COLUMN referrer_id INTEGER REFERENCES users(id);
-- When the referred user makes their first entry, the referrer is credited once.
ALTER TABLE users ADD COLUMN referrer_bonus_granted INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
