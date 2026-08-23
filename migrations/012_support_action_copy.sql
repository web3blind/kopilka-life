-- Make support cards clearer: what the user opens and why it helps.
UPDATE support_actions
SET title = 'Открыть VK-сообщество',
    description = 'Там будут новости Копилки и спокойные обновления. Ваша подписка и реакции помогут проекту стать заметнее.',
    button_label = 'Открыть и засчитать',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'vk-community';

UPDATE support_actions
SET title = 'Открыть личную страницу автора',
    description = 'Там живые заметки Дениса о разработке, доступности и пути проекта. Подписка помогает автору оставаться на связи с теми, кому это близко.',
    button_label = 'Открыть и засчитать',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'vk-author-page';

UPDATE support_actions
SET title = 'Открыть блог про ИИ-агентов',
    description = 'Там заметки про ИИ-агентов, доступность и разработку. Подписка и реакции помогают этим материалам находить своих людей.',
    button_label = 'Открыть и засчитать',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'vk-ai-agents-blog';

UPDATE support_actions
SET title = 'Открыть Telegram-канал',
    description = 'Там короткие заметки про ИИ-агентов, доступность и работу над проектами. Подписка поможет не потерять обновления.',
    button_label = 'Открыть и засчитать',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'telegram-channel';

UPDATE support_actions
SET title = 'Поделиться Копилкой',
    description = 'Отправьте ссылку человеку, которому может подойти мягкое приложение про жизнь и заботу. Он получит простой способ отмечать день, а проект — шанс найти своего пользователя.',
    button_label = 'Открыть и засчитать',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'share-kopilka';
