-- Support actions: optional cards that help the project/community/partners.
-- Separate from LIFE; credited to a support badge only.
CREATE TABLE IF NOT EXISTS support_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  button_label TEXT NOT NULL,
  url TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'web',
  kind TEXT NOT NULL DEFAULT 'open_url',
  reward_points INTEGER NOT NULL DEFAULT 1,
  is_partner INTEGER NOT NULL DEFAULT 0,
  is_ad INTEGER NOT NULL DEFAULT 0,
  disclosure_text TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_support_actions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id INTEGER NOT NULL REFERENCES support_actions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'shown',
  opened_at TEXT,
  claimed_at TEXT,
  verified_at TEXT,
  credited_at TEXT,
  source TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, action_id)
);
CREATE INDEX IF NOT EXISTS idx_support_actions_active_sort ON support_actions(active, created_at DESC, sort_order DESC);
CREATE INDEX IF NOT EXISTS idx_user_support_actions_user_credit ON user_support_actions(user_id, credited_at);

INSERT OR IGNORE INTO support_actions (slug, title, description, button_label, url, platform, kind, reward_points, is_partner, is_ad, disclosure_text, active, sort_order, created_at) VALUES
('telegram-channel', 'Открыть Telegram Копилки', 'Там будут короткие новости, спокойные обновления и полезные подсказки. Если захочешь — можно подписаться.', 'Открыть и засчитать', 'https://t.me/HarborLifeBot', 'telegram', 'open_url', 1, 0, 0, NULL, 1, 30, '2026-08-23 12:03:00'),
('vk-community', 'Открыть VK-сообщество', 'Там будут новости Копилки и спокойные обновления. Это помогает проекту становиться заметнее.', 'Открыть и засчитать', 'https://vk.com/life_harbor_game', 'vk', 'open_url', 1, 0, 0, NULL, 1, 20, '2026-08-23 12:02:00'),
('share-kopilka', 'Поделиться Копилкой', 'Можно отправить ссылку человеку, которому может подойти мягкое приложение о заботе о себе.', 'Открыть и засчитать', 'https://life.blinddev.xyz', 'web', 'open_url', 1, 0, 0, NULL, 1, 10, '2026-08-23 12:01:00');
