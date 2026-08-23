-- Add English copy for support cards so the English UI does not receive Russian card text.
ALTER TABLE support_actions ADD COLUMN title_en TEXT;
ALTER TABLE support_actions ADD COLUMN description_en TEXT;
ALTER TABLE support_actions ADD COLUMN button_label_en TEXT;
ALTER TABLE support_actions ADD COLUMN disclosure_text_en TEXT;

UPDATE support_actions
SET title_en = 'Open the VK community',
    description_en = 'It has Life Harbor news and calm project updates. Your subscription and reactions help the project become easier to discover.',
    button_label_en = 'Open and count'
WHERE slug = 'vk-community';

UPDATE support_actions
SET title_en = 'Open the author page',
    description_en = 'Denis shares notes about development, accessibility, and the path of the project. A subscription helps the author stay connected with people who care about this work.',
    button_label_en = 'Open and count'
WHERE slug = 'vk-author-page';

UPDATE support_actions
SET title_en = 'Open the AI agents blog',
    description_en = 'There are notes about AI agents, accessibility, and development. Subscriptions and reactions help these materials find the right people.',
    button_label_en = 'Open and count'
WHERE slug = 'vk-ai-agents-blog';

UPDATE support_actions
SET title_en = 'Open the Telegram channel',
    description_en = 'Short notes about AI agents, accessibility, and project work appear there. A subscription helps you not miss updates.',
    button_label_en = 'Open and count'
WHERE slug = 'telegram-channel';

UPDATE support_actions
SET title_en = 'Share Life Harbor',
    description_en = 'Send the link to someone who may need a gentle app about life and care. They get a simple way to mark the day, and the project gets a chance to find its people.',
    button_label_en = 'Open and count'
WHERE slug = 'share-kopilka';
