-- Correct support action destinations after Denis clarified the actual public handles.
UPDATE support_actions
SET title = 'Открыть личную страницу автора',
    description = 'Там живые заметки Дениса о разработке, доступности и пути проекта. Подписка помогает автору оставаться на связи с теми, кому это близко.',
    button_label = 'Открыть и засчитать',
    url = 'https://vk.com/denis_skripnik',
    platform = 'vk',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'vk-author-page';

INSERT OR IGNORE INTO support_actions (slug, title, description, button_label, url, platform, kind, reward_points, is_partner, is_ad, disclosure_text, active, sort_order, created_at) VALUES
('vk-ai-agents-blog', 'Открыть блог про ИИ-агентов', 'Там заметки про ИИ-агентов, доступность и разработку. Подписка и реакции помогают этим материалам находить своих людей.', 'Открыть и засчитать', 'https://vk.com/blind_dev', 'vk', 'open_url', 1, 0, 0, NULL, 1, 28, '2026-08-23 12:05:00');

UPDATE support_actions
SET title = 'Открыть Telegram-канал',
    description = 'Там короткие заметки про ИИ-агентов, доступность и работу над проектами. Подписка поможет не потерять обновления.',
    button_label = 'Открыть и засчитать',
    url = 'https://t.me/blind_dev',
    platform = 'telegram',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'telegram-channel';
