// Central i18n dictionary (RU/EN) for Копилка жизни.
// Locale values are normalized to 'ru' | 'en' via normalizeLocale().

const LOCALES = ['ru', 'en'];
const DEFAULT_LOCALE = 'ru';

function normalizeLocale(locale) {
  const code = String(locale || '').toLowerCase().split('-')[0];
  return LOCALES.includes(code) ? code : DEFAULT_LOCALE;
}

// Short shared strings (UI labels, errors, bot messages, close actions, weekly review).
const STRINGS = {
  // ---- entry type titles + hints ----
  'entry.sleep.title': { ru: 'Нормальный сон', en: 'Good sleep' },
  'entry.sleep.hint': { ru: 'выспался или лёг вовремя', en: 'slept well or went to bed on time' },
  'entry.movement.title': { ru: 'Движение', en: 'Movement' },
  'entry.movement.hint': { ru: 'прогулка, разминка, спорт', en: 'walk, stretch, sport' },
  'entry.food_water.title': { ru: 'Еда или вода', en: 'Food or water' },
  'entry.food_water.hint': { ru: 'поел или попил воды', en: 'ate or drank water' },
  'entry.joy.title': { ru: 'Радость', en: 'Joy' },
  'entry.joy.hint': { ru: 'что-то приятное, без KPI; посмеялся, смешное видео', en: 'something pleasant, no KPI; laughed, a funny video' },
  'entry.gratitude.title': { ru: 'Благодарность', en: 'Gratitude' },
  'entry.gratitude.hint': { ru: 'факт, за который благодарен', en: 'something you are grateful for' },
  'entry.important_task.title': { ru: 'Важное дело', en: 'Important task' },
  'entry.important_task.hint': { ru: 'довёл одно дело до конца', en: 'finished one task' },
  'entry.dream_step.title': { ru: 'Шаг к мечте', en: 'Step to a dream' },
  'entry.dream_step.hint': { ru: 'маленькое действие к мечте или важной цели', en: 'small step toward a dream or important goal' },
  'entry.dreamed.title': { ru: 'Помечтал', en: 'Dreamed' },
  'entry.dreamed.hint': { ru: 'представил, какой жизни хочется', en: 'imagined the life you want' },
  'entry.kind_trace.title': { ru: 'Доброе дело', en: 'Kind deed' },
  'entry.kind_trace.hint': { ru: 'помог, поддержал человека, позаботился о животных или сделал мир чуть теплее', en: 'helped or supported someone, cared for animals, or made the world a little warmer' },
  'entry.gifted_joy.title': { ru: 'Подарил радость', en: 'Gifted joy' },
  'entry.gifted_joy.hint': { ru: 'маленький подарок или приятный жест для другого человека', en: 'a small gift or kind gesture for someone else' },
  'entry.honest_step.title': { ru: 'Честный шаг', en: 'Honest step' },
  'entry.honest_step.hint': { ru: 'не к мечте, а к порядку: признал факт, исправил ошибку, закрыл хвост', en: 'not toward a dream, but toward order: admitted a fact, fixed a mistake, closed a loose end' },
  'entry.social_contact.title': { ru: 'Встреча или звонок', en: 'Meet-up or call' },
  'entry.social_contact.hint': { ru: 'общение с давним другом или подругой', en: 'talked with an old friend' },
  'entry.family_time.title': { ru: 'Время с родными', en: 'Time with family' },
  'entry.family_time.hint': { ru: 'провёл время с родными', en: 'spent time with family' },
  'entry.rest.title': { ru: 'Отдых', en: 'Rest' },
  'entry.rest.hint': { ru: 'восстановился хоть немного', en: 'recovered a little' },
  'entry.hard_day.title': { ru: 'Сложный день', en: 'Hard day' },
  'entry.hard_day.hint': { ru: 'отметил день честно, без оценки', en: 'noted the day honestly, without judgment' },

  // ---- general UI ----
  'ui.life': { ru: 'ЖИЗНЬ', en: 'LIFE' },
  'ui.addLife': { ru: 'добавить {points} ЖИЗНЬ', en: 'add {points} LIFE' },
  'ui.plusLife': { ru: '+{points} ЖИЗНЬ', en: '+{points} LIFE' },
  'ui.noEntriesToday': { ru: 'Сегодня ещё тихо. Можно начать с одного клика.', en: 'Still quiet today. You can start with one tap.' },
  'ui.noWeek': { ru: 'Тихая неделя. Можно продолжить сегодня.', en: 'A quiet week. You can continue today.' },
  'ui.noCategories': { ru: 'Категории появятся после первых записей.', en: 'Categories will appear after the first entries.' },
  'ui.noActiveContract': { ru: 'Активного договора пока нет.', en: 'No active contract yet.' },
  'ui.templatesLoading': { ru: 'Шаблоны загрузятся после подключения.', en: 'Templates will load after connecting.' },
  'ui.currentContract': { ru: 'Текущий договор', en: 'Current contract' },
  'ui.period': { ru: 'Период', en: 'Period' },
  'ui.criteria': { ru: 'Критерий', en: 'Criteria' },
  'ui.careFund': { ru: 'Фонд заботы', en: 'Care fund' },
  'ui.giftSelf': { ru: 'Подарок себе', en: 'Gift to yourself' },
  'ui.contractLastDayReminder': { ru: 'Сегодня стоит выбрать итог договора: получилось выполнить или нет. Это не оценка, а честное закрытие недели.', en: 'Today is the day to choose the contract result: completed or not. It is not a judgment, just an honest weekly close.' },
  'ui.notSpecified': { ru: 'не указан', en: 'not specified' },
  'ui.canChooseLater': { ru: 'можно выбрать позже', en: 'can choose later' },

  // ---- quick statuses ----
  'status.connected': { ru: 'Подключено.', en: 'Connected.' },
  'status.saving': { ru: 'Сохраняю запись…', en: 'Saving entry…' },
  'status.entrySaved': { ru: 'Копилка пополнилась.', en: 'Your Life Harbor is topped up.' },
  'status.creatingContract': { ru: 'Создаю договор заботы…', en: 'Creating a care contract…' },
  'status.contractCreated': { ru: 'Договор заботы создан.', en: 'Care contract created.' },
  'status.closingContract': { ru: 'Сохраняю итог договора…', en: 'Saving contract result…' },
  'status.contractClosed': { ru: 'Итог договора сохранён мягко и без оценки.', en: 'Contract result saved gently, without judgment.' },
  'status.savingSettings': { ru: 'Сохраняю настройки…', en: 'Saving settings…' },
  'status.settingsSaved': { ru: 'Настройки сохранены.', en: 'Settings saved.' },
  'status.practicesUpdated': { ru: 'Практики обновлены под выбранную цель.', en: 'Practices updated for the chosen goal.' },
  'status.templateApplied': { ru: 'Шаблон “{title}” подставлен. Можно отредактировать.', en: 'Template “{title}” filled in. You can edit it.' },
  'status.ready': { ru: 'Готово. Можно пополнить Копилку жизни.', en: 'Ready. You can top up your Life Harbor.' },
  'status.connectFailed': { ru: 'Не удалось подключиться.', en: 'Could not connect.' },
  'status.openFromTelegram': { ru: 'Открой приложение из Telegram ещё раз.', en: 'Open the app from Telegram again.' },
  'status.telegramSession': { ru: 'Telegram-сессия подтверждена.', en: 'Telegram session confirmed.' },
  'status.devMode': { ru: 'Локальный demo-режим для разработки.', en: 'Local demo mode for development.' },
  'status.deletingDemo': { ru: 'Удаляю demo account…', en: 'Deleting demo account…' },
  'status.demoDeleted': { ru: 'Demo account и связанные данные удалены. Создаю чистый demo account…', en: 'Demo account and related data deleted. Creating a fresh demo account…' },
  'status.notDemo': { ru: 'Это не demo account, удаление недоступно.', en: 'This is not a demo account; deletion is not available.' },

  // ---- errors ----
  'error.unknownType': { ru: 'Неизвестный тип записи', en: 'Unknown entry type' },
  'error.session': { ru: 'Не удалось подтвердить сессию. Открой приложение из Telegram ещё раз.', en: 'Could not confirm the session. Open the app from Telegram again.' },
  'error.userNotFound': { ru: 'Пользователь не найден.', en: 'User not found.' },
  'error.telegramSession': { ru: 'Не удалось подтвердить Telegram-сессию. Открой приложение из Telegram ещё раз.', en: 'Could not confirm the Telegram session. Open the app from Telegram again.' },
  'error.contractExists': { ru: 'Уже есть активный договор заботы', en: 'There is already an active care contract' },
  'error.contractFields': { ru: 'Заполни название и критерий договора', en: 'Fill in the contract name and criteria' },
  'error.contractStatus': { ru: 'Неизвестный итог договора', en: 'Unknown contract result' },
  'error.contractNotFound': { ru: 'Активный договор не найден', en: 'Active contract not found' },
  'error.actionFailed': { ru: 'Не получилось выполнить действие.', en: 'Could not complete the action.' },

  // ---- contract close actions ----
  'close.completed': { ru: 'Выполнил и подарил себе', en: 'Completed and gifted myself' },
  'close.not_completed_donated': { ru: 'Не выполнил и отправил в фонд', en: 'Did not complete and donated' },
  'close.too_hard': { ru: 'Цель была слишком сложной', en: 'The goal was too hard' },
  'close.cancelled': { ru: 'Отменить без наказания', en: 'Cancel without penalty' },

  // ---- contract entry titles ----
  'contractEntry.completed': { ru: 'Выполненный недельный договор', en: 'Completed weekly contract' },
  'contractEntry.honest': { ru: 'Честный итог договора', en: 'Honest contract result' },

  // ---- weekly review sentences ----
  'review.quietWeek': { ru: 'На этой неделе пока тихо. Это не провал: можно начать с одного мягкого действия сегодня.', en: 'The week is still quiet. That is not a failure: you can start with one gentle action today.' },
  'review.weekSummary': { ru: 'На этой неделе было {days} дн. с пополнениями и {life} ЖИЗНЬ.', en: 'This week had {days} days with entries and {life} LIFE.' },
  'review.topCategory': { ru: 'Чаще всего встречалось: {top}.', en: 'Most common: {top}.' },
  'review.activeContract': { ru: 'Активный договор: {title}.', en: 'Active contract: {title}.' },
  'review.lastContract': { ru: 'Последний договор закрыт со статусом: {status}.', en: 'Last contract closed with status: {status}.' },
  'review.noContract': { ru: 'Недельный договор ещё можно создать по шаблону, если хочется мягкой опоры.', en: 'You can still create a weekly contract from a template if you want gentle support.' },
  'review.q1': { ru: 'Что на этой неделе реально поддержало жизнь?', en: 'What really supported life this week?' },
  'review.q2': { ru: 'Что можно упростить на следующей неделе?', en: 'What could be simplified next week?' },
  'review.q3': { ru: 'Какой договор будет достаточно мягким, чтобы его хотелось продолжать?', en: 'Which contract would be gentle enough to want to keep going?' },
  'review.closeStatus.completed': { ru: 'выполнен', en: 'completed' },
  'review.closeStatus.not_completed_donated': { ru: 'не выполнен, отправлено в фонд', en: 'not completed, donated' },
  'review.closeStatus.too_hard': { ru: 'слишком сложная цель', en: 'goal was too hard' },
  'review.closeStatus.cancelled': { ru: 'отменён', en: 'cancelled' },

  // ---- bot messages ----
  'bot.open': { ru: 'Открыть Копилку жизни', en: 'Open your Life Harbor' },
  'bot.start': { ru: 'Это Копилка жизни. Здесь можно за 10 секунд отметить маленькие вещи, которые поддержали день.', en: 'This is your Life Harbor. Here you can note small things that supported your day in 10 seconds.' },
  'bot.reminder': { ru: 'Если есть силы, можно за 10 секунд пополнить Копилку жизни.', en: 'If you have the energy, you can top up your Life Harbor in 10 seconds.' },
  'vk.reminder': { ru: 'Вечер. Можно за 10 секунд отметить, что сегодня поддержало жизнь.', en: 'Evening. You can take 10 seconds to note what supported life today.' },
  'reminder.contractLastDay': { ru: 'Недельный договор ждёт итога: выполнен он или нет.', en: 'Your weekly contract is waiting for its result: completed or not.' },
  'inline.shareTitle': { ru: 'Копилка жизни', en: 'Life Harbor' },
};

// ---- product content (hints, contract templates, practices, goals) ----
// Each content item carries { ru, en } variants. A tiny helper picks by locale.

function pick(value, locale) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value[locale] || value[DEFAULT_LOCALE] || '';
}

const DAILY_HINTS = [
  { id: 'tiny-start', title: { ru: 'Начни с самого маленького', en: 'Start with the smallest thing' }, text: { ru: 'Если сил мало, отметь один честный след заботы. Сегодня достаточно одного клика.', en: 'If you have little energy, note one honest trace of care. One tap is enough today.' }, action: { ru: 'Подойдёт “Отдых” или “Сложный день”.', en: '“Rest” or “Hard day” works.' } },
  { id: 'body-check', title: { ru: 'Проверь тело', en: 'Check your body' }, text: { ru: 'Спроси себя: вода, еда, движение или сон сейчас поддержат меня сильнее всего?', en: 'Ask yourself: would water, food, movement, or sleep support you most right now?' }, action: { ru: 'Выбери категорию, которая ближе к реальному действию.', en: 'Choose the category closest to a real action.' } },
  { id: 'joy-not-kpi', title: { ru: 'Радость без KPI', en: 'Joy without KPI' }, text: { ru: 'Радость не обязана быть большой. Подойдёт короткая песня, тёплый чай или сообщение хорошему человеку.', en: 'Joy does not have to be big. A short song, warm tea, or a message to a good person all count.' }, action: { ru: 'Если это уже было — отметь “Радость”.', en: 'If that already happened, mark “Joy”.' } },
  { id: 'soft-contract', title: { ru: 'Упрости договор', en: 'Simplify the contract' }, text: { ru: 'Хороший недельный договор — это “5 дней из 7”, а не “каждый день”. Так цель остаётся достижимой и не давит.', en: 'A good weekly contract is “5 days of 7”, not “every day”. That keeps the goal reachable and gentle.' }, action: { ru: 'Если цель давит, сделай её мягче.', en: 'If the goal feels heavy, make it gentler.' } },
  { id: 'gratitude', title: { ru: 'Один факт благодарности', en: 'One fact of gratitude' }, text: { ru: 'Можно отметить не настроение, а факт: что сегодня немного помогло?', en: 'Note a fact, not a mood: what helped a little today?' }, action: { ru: 'Запиши короткую заметку или просто нажми “Благодарность”.', en: 'Write a short note or just tap “Gratitude”.' } },
  { id: 'dream-step', title: { ru: 'Шаг к мечте может быть маленьким', en: 'A step to a dream can be small' }, text: { ru: 'Один вопрос, один файл, одно сообщение или 10 минут — уже след движения.', en: 'One question, one file, one message, or 10 minutes — that is already a trace of movement.' }, action: { ru: 'Если сделал такой шаг, отметь “Шаг к мечте”.', en: 'If you took such a step, mark “Step to a dream”.' } },
  { id: 'rest-permission', title: { ru: 'Отдых тоже пополняет', en: 'Rest also fills you up' }, text: { ru: 'Отдых — не награда после идеального дня, а топливо для следующего шага.', en: 'Rest is not a reward after a perfect day, but fuel for the next step.' }, action: { ru: 'Если сегодня восстановился хоть немного, отметь “Отдых”.', en: 'If you recovered even a little today, mark “Rest”.' } },
  { id: 'ordinary-support', title: { ru: 'Обычное чудо', en: 'An ordinary wonder' }, text: { ru: 'Иногда жизнь поддерживает что-то простое: вода, воздух, тепло, рабочий телефон, голос рядом или безопасная комната.', en: 'Sometimes something simple supports life: water, air, warmth, a working phone, a voice nearby, or a safe room.' }, action: { ru: 'Если заметил такую опору — подойдёт “Благодарность” или короткая заметка.', en: 'If you noticed such support, “Gratitude” or a short note works.' } },
  { id: 'kind-trace', title: { ru: 'Доброе дело', en: 'Kind deed' }, text: { ru: 'Доброе дело — это конкретная помощь: человеку, животным, месту рядом. Не обязательно подвиг, но что-то живое и полезное.', en: 'A kind deed is concrete help: to a person, animals, or the place around you. It does not have to be heroic, but it is alive and useful.' }, action: { ru: 'Если сделал такое — отметь “Доброе дело”.', en: 'If you did that, mark “Kind deed”.' } },
  { id: 'honest-millimeter', title: { ru: 'Честный шаг', en: 'Honest step' }, text: { ru: 'Это не шаг к мечте, а шаг к порядку: признать факт, исправить ошибку, закрыть хвост или перестать прятать мелочь.', en: 'This is not a step toward a dream, but a step toward order: admit a fact, fix a mistake, close a loose end, or stop hiding a small thing.' }, action: { ru: 'Если сделал такой шаг — отметь “Честный шаг”.', en: 'If you took such a step, mark “Honest step”.' } },
  { id: 'life-before-chase', title: { ru: 'Жизнь важнее гонки', en: 'Life matters more than the chase' }, text: { ru: 'Не всё надо добывать прямо сейчас. Иногда главный прогресс — выбрать один живой шаг и не доказывать ценность весь день.', en: 'Not everything has to be earned right now. Sometimes the main progress is to pick one living step and not prove your worth all day.' }, action: { ru: 'Сделай одно конкретное действие и пополни Копилку. Этого уже достаточно, если сил мало.', en: 'Do one concrete action and top up your Life Harbor. That is already enough if you have little energy.' } }
];

const CONTRACT_TEMPLATES = [
  { id: 'sleep-5-of-7', title: { ru: 'Сон 5 из 7', en: 'Sleep 5 of 7' }, targetValue: { ru: 'Лечь до выбранного времени минимум 5 дней из 7', en: 'Go to bed by the chosen time at least 5 days of 7' }, rewardDescription: { ru: 'Спокойный подарок себе без чувства вины', en: 'A calm gift to yourself without guilt' }, fundDescription: { ru: 'Фонд заботы или донат, который мне не жалко', en: 'A care fund or donation I do not mind' } },
  { id: 'movement-4-of-7', title: { ru: 'Движение 4 из 7', en: 'Movement 4 of 7' }, targetValue: { ru: 'Сделать любое мягкое движение минимум 4 дня из 7', en: 'Do any gentle movement at least 4 days of 7' }, rewardDescription: { ru: 'Небольшой подарок для тела', en: 'A small gift for your body' }, fundDescription: { ru: 'Благотворительный фонд или open-source donation', en: 'A charity or open-source donation' } },
  { id: 'gratitude-5-of-7', title: { ru: 'Благодарность 5 из 7', en: 'Gratitude 5 of 7' }, targetValue: { ru: 'Отметить один факт благодарности минимум 5 дней из 7', en: 'Note one fact of gratitude at least 5 days of 7' }, rewardDescription: { ru: 'Вечер без спешки или приятная мелочь', en: 'A calm evening or a small pleasant thing' }, fundDescription: { ru: 'Фонд будущего себя', en: 'A fund for your future self' } },
  { id: 'dream-3-of-7', title: { ru: 'Мечта 3 из 7', en: 'Dream 3 of 7' }, targetValue: { ru: 'Сделать маленький шаг к мечте минимум 3 дня из 7', en: 'Take a small step to your dream at least 3 days of 7' }, rewardDescription: { ru: 'Время на любимый проект', en: 'Time for your favorite project' }, fundDescription: { ru: 'Экспериментальный кошелёк агента или донат', en: 'An experimental agent wallet or donation' } },
  { id: 'kind-trace-3-of-7', title: { ru: 'Доброе дело 3 из 7', en: 'Kind deed 3 of 7' }, targetValue: { ru: 'Сделать одно доброе дело минимум 3 дня из 7', en: 'Do one kind deed at least 3 days of 7' }, rewardDescription: { ru: 'Приятная мелочь без чувства вины', en: 'A small pleasant thing without guilt' }, fundDescription: { ru: 'Фонд заботы или донат, который не давит', en: 'A care fund or donation that does not pressure' } },
  { id: 'honest-step-4-of-7', title: { ru: 'Честный шаг 4 из 7', en: 'Honest step 4 of 7' }, targetValue: { ru: 'Сделать один честный маленький шаг минимум 4 дня из 7', en: 'Take one honest small step at least 4 days of 7' }, rewardDescription: { ru: 'Спокойный вечер или время на себя', en: 'A calm evening or time for yourself' }, fundDescription: { ru: 'Фонд будущего себя', en: 'A fund for your future self' } }
];

const PRACTICE_GOALS = [
  { id: 'sleep', title: { ru: 'Сон и восстановление', en: 'Sleep and recovery' } },
  { id: 'energy', title: { ru: 'Энергия и тело', en: 'Energy and body' } },
  { id: 'calm', title: { ru: 'Спокойствие', en: 'Calm' } },
  { id: 'joy', title: { ru: 'Радость', en: 'Joy' } },
  { id: 'dream', title: { ru: 'Шаг к мечте', en: 'Step to a dream' } },
  { id: 'kindness', title: { ru: 'Доброе дело', en: 'Kind deed' } },
  { id: 'honesty', title: { ru: 'Честный шаг', en: 'Honest step' } }
];

const PRACTICES_BY_GOAL = {
  sleep: [
    { ru: 'Выбери одно время, после которого не начинаешь новые тяжёлые задачи.', en: 'Pick one time after which you do not start new heavy tasks.' },
    { ru: 'Подготовь сон на 2 минуты: вода, тишина, зарядка телефона, один незавершённый пункт в заметку.', en: 'Prepare sleep in 2 minutes: water, quiet, phone charging, one unfinished item into a note.' },
    { ru: 'Если лечь рано не вышло, отметь хотя бы честный итог без самокритики.', en: 'If going to bed early did not work, at least note an honest result without self-criticism.' }
  ],
  energy: [
    { ru: 'Сделай 3–5 минут мягкого движения: плечи, шея, короткая прогулка или растяжка.', en: 'Do 3–5 minutes of gentle movement: shoulders, neck, a short walk, or stretching.' },
    { ru: 'Проверь базу: вода, еда, воздух. Выбери одно действие, не весь список.', en: 'Check the basics: water, food, air. Pick one action, not the whole list.' },
    { ru: 'Зафиксируй “движение” даже если оно было маленьким: система поддерживает факт, не рекорд.', en: 'Note “movement” even if it was small: the system supports the fact, not a record.' }
  ],
  calm: [
    { ru: 'Назови один следующий маленький шаг, а не весь план.', en: 'Name one next small step, not the whole plan.' },
    { ru: 'Сделай паузу на 5 спокойных выдохов перед новым делом.', en: 'Take a pause of 5 calm breaths before the next task.' },
    { ru: 'Спроси: что сегодня можно упростить без ущерба для важного?', en: 'Ask: what could be simplified today without harming what matters?' }
  ],
  joy: [
    { ru: 'Добавь короткую радость до результата: музыка, чай, шутка, тёплое сообщение.', en: 'Add a short joy before the result: music, tea, a joke, a warm message.' },
    { ru: 'Отметь радость как факт, даже если день в целом был сложным.', en: 'Mark joy as a fact, even if the day was hard overall.' },
    { ru: 'Сохрани одну приятную деталь дня в заметку к записи.', en: 'Save one pleasant detail of the day in a note to the entry.' }
  ],
  dream: [
    { ru: 'Сделай 10 минут работы над мечтой без требования закончить.', en: 'Do 10 minutes of work on your dream without needing to finish.' },
    { ru: 'Сформулируй один вопрос, который двинет проект дальше.', en: 'Formulate one question that moves the project forward.' },
    { ru: 'Отправь одно сообщение или открой один файл — маленький запуск считается.', en: 'Send one message or open one file — a small start counts.' }
  ],
  kindness: [
    { ru: 'Отправь одно короткое тёплое сообщение без требования ответа.', en: 'Send one short warm message without expecting a reply.' },
    { ru: 'Скажи конкретное спасибо человеку, сервису или себе за одну реальную помощь.', en: 'Say a concrete thank you to a person, a service, or yourself for one real help.' },
    { ru: 'Сделай маленькое добро без героизма: подсказать, поддержать, убрать один лишний шум.', en: 'Do a small kindness without heroics: suggest, support, remove one extra noise.' }
  ],
  honesty: [
    { ru: 'Выбери один честный маленький шаг: признать факт, исправить мелочь, закрыть один хвост.', en: 'Pick one honest small step: admit a fact, fix a small thing, close one loose end.' },
    { ru: 'Раздели сигнал и шум: что реально требует действия, а что только гонит и пугает?', en: 'Separate signal from noise: what really needs action, and what only pushes and scares?' },
    { ru: 'Сделай один шаг, после которого можно чуть больше уважать себя, и остановись.', en: 'Take one step after which you can respect yourself a little more, then stop.' }
  ]
};

// Translate a key with {param} substitution.
function t(locale, key, params = {}) {
  const entry = STRINGS[key];
  if (!entry) return key;
  const value = entry[normalizeLocale(locale)] || entry[DEFAULT_LOCALE] || key;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

module.exports = {
  LOCALES,
  DEFAULT_LOCALE,
  normalizeLocale,
  pick,
  t,
  STRINGS,
  DAILY_HINTS,
  CONTRACT_TEMPLATES,
  PRACTICE_GOALS,
  PRACTICES_BY_GOAL
};
