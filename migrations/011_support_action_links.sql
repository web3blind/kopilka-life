-- Correct support action destinations after Denis clarified the actual public handles.
UPDATE support_actions
SET title = 'Открыть личную страницу автора',
    description = 'Личная страница Дениса Скрипника в VK: путь проекта, заметки и живой контекст автора.',
    button_label = 'Открыть и засчитать',
    url = 'https://vk.com/denis_skripnik',
    platform = 'vk',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'vk-author-page';

INSERT OR IGNORE INTO support_actions (slug, title, description, button_label, url, platform, kind, reward_points, is_partner, is_ad, disclosure_text, active, sort_order, created_at) VALUES
('vk-ai-agents-blog', 'Открыть блог про ИИ-агентов', 'Блог Blind Dev в VK: заметки про ИИ-агентов, доступность и разработку.', 'Открыть и засчитать', 'https://vk.com/blind_dev', 'vk', 'open_url', 1, 0, 0, NULL, 1, 28, '2026-08-23 12:05:00');

UPDATE support_actions
SET title = 'Открыть Telegram-канал',
    description = 'Канал Blind Dev в Telegram: заметки про ИИ, агентов, доступность и разработку.',
    button_label = 'Открыть и засчитать',
    url = 'https://t.me/blind_dev',
    platform = 'telegram',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'telegram-channel';
