-- One-time verified VK identity proofs for authenticated OAuth account linking.
CREATE TABLE IF NOT EXISTS vk_oauth_link_proofs (
  proof_hash TEXT PRIMARY KEY,
  target_user_id INTEGER NOT NULL,
  vk_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vk_oauth_link_proofs_expiry ON vk_oauth_link_proofs(expires_at);
