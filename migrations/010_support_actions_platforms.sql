-- Support action surface filtering and extra VK author card.
-- 'common' actions are shown on VK, Telegram and web. Platform-specific actions stay on their surface.
UPDATE support_actions SET platform = 'common' WHERE slug = 'share-kopilka' AND platform = 'web';

INSERT OR IGNORE INTO support_actions (slug, title, description, button_label, url, platform, kind, reward_points, is_partner, is_ad, disclosure_text, active, sort_order, created_at) VALUES
('vk-author-page', 'Открыть личную страницу автора', 'Там живые заметки Дениса о разработке, доступности и пути проекта. Подписка помогает автору оставаться на связи с теми, кому это близко.', 'Открыть и засчитать', 'https://vk.com/blind_dev', 'vk', 'open_url', 1, 0, 0, NULL, 1, 25, '2026-08-23 12:04:00');
