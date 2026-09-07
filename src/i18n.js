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
  'entry.savoring.title': { ru: 'Наслаждение', en: 'Savoring' },
  'entry.savoring.hint': { ru: 'вкус, тепло, запах, звук или красивый момент', en: 'a taste, warmth, scent, sound, or beautiful moment' },
  'entry.gratitude.title': { ru: 'Благодарность', en: 'Gratitude' },
  'entry.gratitude.hint': { ru: 'кому или чему благодарен сегодня', en: 'who or what you are grateful to today' },
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
  'error.entryAlreadyToday': { ru: 'Этот вариант уже добавлен сегодня. Завтра он снова будет доступен.', en: 'This entry is already saved for today. It will be available again tomorrow.' },
  'error.session': { ru: 'Не удалось подтвердить сессию. Открой приложение ещё раз.', en: 'Could not confirm the session. Open the app again.' },
  'error.userNotFound': { ru: 'Пользователь не найден.', en: 'User not found.' },
  'error.telegramSession': { ru: 'Не удалось подтвердить Telegram-сессию. Открой приложение из Telegram ещё раз.', en: 'Could not confirm the Telegram session. Open the app from Telegram again.' },
  'error.vkSession': { ru: 'Не удалось подтвердить VK-сессию. Открой приложение из VK ещё раз.', en: 'Could not confirm the VK session. Open the app from VK again.' },
  'error.contractExists': { ru: 'Уже есть активный договор заботы', en: 'There is already an active care contract' },
  'error.contractFields': { ru: 'Заполни название и критерий договора', en: 'Fill in the contract name and criteria' },
  'error.contractStatus': { ru: 'Неизвестный итог договора', en: 'Unknown contract result' },
  'error.contractNotFound': { ru: 'Активный договор не найден', en: 'Active contract not found' },
  'error.historyDate': { ru: 'Укажи дату в формате ГГГГ-ММ-ДД.', en: 'Choose a valid date.' },
  'error.historyDays': { ru: 'Можно загрузить от 1 до 31 дня истории.', en: 'You can load from 1 to 31 history days.' },
  'error.historyFuture': { ru: 'Будущие дни пока не содержат истории.', en: 'Future days do not have history yet.' },
  'error.entryNotFound': { ru: 'Эта запись не найдена.', en: 'This entry was not found.' },
  'error.entryProtected': { ru: 'Системное начисление нельзя изменить или удалить.', en: 'A system award cannot be edited or deleted.' },
  'error.entryNoteTooLong': { ru: 'Заметка может содержать не больше 2000 символов.', en: 'A note can contain no more than 2000 characters.' },
  'error.entryDeleteConfirm': { ru: 'Подтверди удаление случайной отметки.', en: 'Confirm deletion of the accidental entry.' },
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
  {"id": "tiny-start", "title": {"ru": "Если сил мало", "en": "When you have little energy"}, "text": {"ru": "Не обязательно браться за большое дело. Можно поесть, выпить воды или отдохнуть. Выбери то, что тебе сейчас по силам.", "en": "You do not have to take on a big task. You could eat, drink some water, or rest. Choose what feels manageable right now."}, "action": {"ru": "Отметь то, что действительно сделал. Если день выдался тяжёлым, можно выбрать «Сложный день».", "en": "Log what you actually did. If the day has been difficult, you can choose “Hard day”."}},
  {"id": "body-check", "title": {"ru": "Чего сейчас не хватает?", "en": "What do you need right now?"}, "text": {"ru": "Ты голоден, хочешь пить, устал или засиделся на одном месте? Прислушайся к себе и выбери подходящее действие: поесть, попить, поспать или немного подвигаться.", "en": "Are you hungry, thirsty, tired, or have you been sitting for a long time? Notice how you feel and choose what you need: food, water, sleep, or a little movement."}, "action": {"ru": "После этого отметь «Еда или вода», «Сон» или «Движение» — в зависимости от того, что сделал.", "en": "Afterwards, log “Food or water”, “Sleep”, or “Movement”, depending on what you did."}},
  {"id": "joy-not-kpi", "title": {"ru": "Что порадовало сегодня?", "en": "What made you happy today?"}, "text": {"ru": "Ты посмеялся над шуткой, получил хорошую новость или отпраздновал важное для тебя событие? Вспомни, чему ты сегодня обрадовался.", "en": "Did a joke make you laugh, did you get good news, or did you celebrate something important to you? Think of something that made you happy today."}, "action": {"ru": "Если такой момент был — отметь «Радость».", "en": "If you had a moment like that, log “Joy”."}},
  {"id": "soft-contract", "title": {"ru": "Посильный договор", "en": "A manageable contract"}, "text": {"ru": "Если выполнять цель каждый день трудно, в следующем недельном договоре можно выбрать меньше дней или уменьшить объём дела. Учитывай своё время и силы.", "en": "If meeting your goal every day is difficult, your next weekly contract can include fewer days or a smaller task. Take your time and energy into account."}, "action": {"ru": "Когда будешь составлять следующий договор, выбери посильное условие.", "en": "When you make your next contract, choose a condition you can reasonably meet."}},
  {"id": "gratitude", "title": {"ru": "За что хочется поблагодарить?", "en": "What are you grateful for?"}, "text": {"ru": "Кто-то помог тебе, выслушал или поддержал? Можно поблагодарить этого человека или записать, за что ты ему благодарен.", "en": "Did someone help you, listen to you, or support you? You could thank them or write down what you are grateful to them for."}, "action": {"ru": "Если сегодня почувствовал благодарность — отметь «Благодарность». Заметку можно добавить по желанию.", "en": "If you felt grateful today, log “Gratitude”. You can add a note if you want."}},
  {"id": "dream-step", "title": {"ru": "Шаг к мечте", "en": "A step toward your dream"}, "text": {"ru": "Что ты сегодня сделал для своей мечты? Например, нашёл нужную информацию о будущей поездке, позанимался языком для неё или сделал часть проекта, который давно хотел запустить.", "en": "What did you do for your dream today? Perhaps you found information for a trip you want to take, practised a language for it, or worked on a project you have wanted to start."}, "action": {"ru": "Если сделал что-то, что приближает тебя к мечте, отметь «Шаг к мечте».", "en": "If you did something that brings your dream closer, log “Step to a dream”."}},
  {"id": "rest-permission", "title": {"ru": "Время на отдых", "en": "Time to rest"}, "text": {"ru": "Можно сделать перерыв, полежать в тишине или провести вечер без дел. Отдыхать можно и тогда, когда не всё закончено.", "en": "You can take a break, lie down somewhere quiet, or set your tasks aside for the evening. You can rest even when not everything is finished."}, "action": {"ru": "Если сегодня выделил время на отдых — отметь «Отдых».", "en": "If you made time to rest today, log “Rest”."}},
  {"id": "ordinary-support", "title": {"ru": "Благодарность за повседневное", "en": "Everyday gratitude"}, "text": {"ru": "Тёплый дом, чистая вода или возможность позвонить близкому часто кажутся привычными. Есть ли среди обычных вещей что-то, за что ты сегодня благодарен?", "en": "A warm home, clean water, or being able to call someone close can feel ordinary. Is there something in everyday life that you feel grateful for today?"}, "action": {"ru": "Если есть — отметь «Благодарность» и, если хочется, напиши за что.", "en": "If there is, log “Gratitude” and add what you are grateful for if you want."}},
  {"id": "kind-trace", "title": {"ru": "Кому ты помог?", "en": "Who did you help?"}, "text": {"ru": "Помог человеку разобраться с трудной задачей, поучаствовал в уходе за животным или убрал мусор в общем дворе? Небольшая помощь тоже может быть добрым делом.", "en": "Did you help someone with a difficult task, help care for an animal, or pick up litter in a shared yard? Small acts of help can be kind deeds too."}, "action": {"ru": "Если сегодня сделал доброе дело — отметь «Доброе дело».", "en": "If you did a kind deed today, log “Kind deed”."}},
  {"id": "honest-millimeter", "title": {"ru": "Честный шаг", "en": "An honest step"}, "text": {"ru": "Признал свою ошибку, рассказал о проблеме, которую скрывал, или честно предупредил, что не сможешь выполнить обещание? Это можно отметить как честный шаг.", "en": "Did you admit a mistake, speak about a problem you had been hiding, or honestly explain that you could not keep a promise? You can record that as an honest step."}, "action": {"ru": "Если сегодня поступил так — отметь «Честный шаг».", "en": "If you did something like that today, log “Honest step”."}},
  {"id": "life-before-chase", "title": {"ru": "Не обязательно успеть всё", "en": "You do not have to finish everything"}, "text": {"ru": "Если дел больше, чем сил, выбери одно важное на сегодня. Остальное можно перенести или пересмотреть: не каждое дело требует решения прямо сейчас.", "en": "If your tasks exceed your energy, choose one important thing for today. You can postpone or reconsider the rest: not everything needs to be resolved right now."}, "action": {"ru": "Если завершил важное для тебя дело — отметь «Важное дело».", "en": "If you finished a task that matters to you, log “Important task”."}}
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
