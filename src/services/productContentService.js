const { getWeekSummary } = require('./entriesService');
const { getCurrentContract, getLatestContract } = require('./contractsService');

const DAILY_HINTS = [
  { id: 'tiny-start', title: 'Начни с самого маленького', text: 'Если сил мало, отметь один честный след заботы. Сегодня достаточно одного клика.', action: 'Подойдёт “Отдых” или “Сложный день”.' },
  { id: 'body-check', title: 'Проверь тело', text: 'Спроси себя: вода, еда, движение или сон сейчас поддержат меня сильнее всего?', action: 'Выбери категорию, которая ближе к реальному действию.' },
  { id: 'joy-not-kpi', title: 'Радость без KPI', text: 'Радость не обязана быть большой. Подойдёт короткая песня, тёплый чай или сообщение хорошему человеку.', action: 'Если это уже было — отметь “Радость”.' },
  { id: 'soft-contract', title: 'Упрости договор', text: 'Хороший недельный договор звучит как “5 из 7”, а не как “всегда”.', action: 'Если цель давит, сделай её мягче.' },
  { id: 'gratitude', title: 'Один факт благодарности', text: 'Можно отметить не настроение, а факт: что сегодня немного помогло?', action: 'Запиши короткую заметку или просто нажми “Благодарность”.' },
  { id: 'dream-step', title: 'Шаг к мечте может быть маленьким', text: 'Один вопрос, один файл, одно сообщение или 10 минут — уже след движения.', action: 'Если сделал такой шаг, отметь “Шаг к мечте”.' },
  { id: 'rest-permission', title: 'Отдых тоже пополняет', text: 'Отдых — не награда после идеального дня, а топливо для следующего шага.', action: 'Если сегодня восстановился хоть немного, отметь “Отдых”.' },
  { id: 'ordinary-support', title: 'Обычное чудо', text: 'Иногда жизнь поддерживает что-то простое: вода, воздух, тепло, рабочий телефон, голос рядом или безопасная комната.', action: 'Если заметил такую опору — подойдёт “Благодарность” или короткая заметка.' },
  { id: 'kind-trace', title: 'Доброе дело', text: 'Маленькое добро тоже пополняет жизнь: помощь, спасибо, тёплое сообщение, конкретный комплимент.', action: 'Если сделал такое — отметь “Доброе дело”.' },
  { id: 'honest-millimeter', title: 'Честный шаг', text: 'Когда давит ошибка или тревога, не надо чинить всё. Один честный маленький шаг уже возвращает опору.', action: 'Если сделал такой шаг — отметь “Честный шаг”.' },
  { id: 'life-before-chase', title: 'Жизнь важнее гонки', text: 'Не всё надо добывать прямо сейчас. Иногда главный прогресс — выбрать один живой шаг и не доказывать ценность весь день.', action: 'Сделай одно конкретное действие и пополни Копилку. Этого уже достаточно, если сил мало.' }
];

const CONTRACT_TEMPLATES = [
  { id: 'sleep-5-of-7', title: 'Сон 5 из 7', targetValue: 'Лечь до выбранного времени минимум 5 дней из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Спокойный подарок себе без чувства вины', fundDescription: 'Фонд заботы или донат, который мне не жалко' },
  { id: 'movement-4-of-7', title: 'Движение 4 из 7', targetValue: 'Сделать любое мягкое движение минимум 4 дня из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Небольшой подарок для тела', fundDescription: 'Благотворительный фонд или open-source donation' },
  { id: 'gratitude-5-of-7', title: 'Благодарность 5 из 7', targetValue: 'Отметить один факт благодарности минимум 5 дней из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Вечер без спешки или приятная мелочь', fundDescription: 'Фонд будущего себя' },
  { id: 'dream-3-of-7', title: 'Мечта 3 из 7', targetValue: 'Сделать маленький шаг к мечте минимум 3 дня из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Время на любимый проект', fundDescription: 'Экспериментальный кошелёк агента или донат' },
  { id: 'kind-trace-3-of-7', title: 'Доброе дело 3 из 7', targetValue: 'Сделать одно доброе дело минимум 3 дня из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Приятная мелочь без чувства вины', fundDescription: 'Фонд заботы или донат, который не давит' },
  { id: 'honest-step-4-of-7', title: 'Честный шаг 4 из 7', targetValue: 'Сделать один честный маленький шаг минимум 4 дня из 7', stakeAmount: '', stakeCurrency: 'RUB', rewardDescription: 'Спокойный вечер или время на себя', fundDescription: 'Фонд будущего себя' }
];

const PRACTICE_GOALS = [
  { id: 'sleep', title: 'Сон и восстановление' },
  { id: 'energy', title: 'Энергия и тело' },
  { id: 'calm', title: 'Спокойствие' },
  { id: 'joy', title: 'Радость' },
  { id: 'dream', title: 'Шаг к мечте' },
  { id: 'kindness', title: 'Доброе дело' },
  { id: 'honesty', title: 'Честный шаг' }
];

const PRACTICES_BY_GOAL = {
  sleep: [
    'Выбери одно время, после которого не начинаешь новые тяжёлые задачи.',
    'Подготовь сон на 2 минуты: вода, тишина, зарядка телефона, один незавершённый пункт в заметку.',
    'Если лечь рано не вышло, отметь хотя бы честный итог без самокритики.'
  ],
  energy: [
    'Сделай 3–5 минут мягкого движения: плечи, шея, короткая прогулка или растяжка.',
    'Проверь базу: вода, еда, воздух. Выбери одно действие, не весь список.',
    'Зафиксируй “движение” даже если оно было маленьким: система поддерживает факт, не рекорд.'
  ],
  calm: [
    'Назови один следующий маленький шаг, а не весь план.',
    'Сделай паузу на 5 спокойных выдохов перед новым делом.',
    'Спроси: что сегодня можно упростить без ущерба для важного?'
  ],
  joy: [
    'Добавь короткую радость до результата: музыка, чай, шутка, тёплое сообщение.',
    'Отметь радость как факт, даже если день в целом был сложным.',
    'Сохрани одну приятную деталь дня в заметку к записи.'
  ],
  dream: [
    'Сделай 10 минут работы над мечтой без требования закончить.',
    'Сформулируй один вопрос, который двинет проект дальше.',
    'Отправь одно сообщение или открой один файл — маленький запуск считается.'
  ],
  kindness: [
    'Отправь одно короткое тёплое сообщение без требования ответа.',
    'Скажи конкретное спасибо человеку, сервису или себе за одну реальную помощь.',
    'Сделай маленькое добро без героизма: подсказать, поддержать, убрать один лишний шум.'
  ],
  honesty: [
    'Выбери один честный маленький шаг: признать факт, исправить мелочь, закрыть один хвост.',
    'Раздели сигнал и шум: что реально требует действия, а что только гонит и пугает?',
    'Сделай один шаг, после которого можно чуть больше уважать себя, и остановись.'
  ]
};

function dailyHintForUser(userId) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  return DAILY_HINTS[(Number(userId) + dayIndex) % DAILY_HINTS.length];
}

function getPractices(goal = 'calm') {
  const normalized = PRACTICES_BY_GOAL[goal] ? goal : 'calm';
  return { goal: normalized, goals: PRACTICE_GOALS, practices: PRACTICES_BY_GOAL[normalized] };
}

function buildWeeklyReview(userId) {
  const week = getWeekSummary(userId);
  const currentContract = getCurrentContract(userId);
  const latestContract = currentContract || getLatestContract(userId);
  const top = week.topCategories[0]?.title;
  const parts = [];
  if (week.activeDays === 0) parts.push('На этой неделе пока тихо. Это не провал: можно начать с одного мягкого действия сегодня.');
  else parts.push(`На этой неделе было ${week.activeDays} дн. с пополнениями и ${week.weekLife} ЖИЗНЬ.`);
  if (top) parts.push(`Чаще всего встречалось: ${top}.`);
  if (latestContract) parts.push(currentContract ? `Активный договор: ${latestContract.title}.` : `Последний договор закрыт со статусом: ${latestContract.status}.`);
  else parts.push('Недельный договор ещё можно создать по шаблону, если хочется мягкой опоры.');
  return {
    summaryText: parts.join(' '),
    activeDays: week.activeDays,
    weekLife: week.weekLife,
    topCategory: top || null,
    contract: latestContract || null,
    questions: [
      'Что на этой неделе реально поддержало жизнь?',
      'Что можно упростить на следующей неделе?',
      'Какой договор будет достаточно мягким, чтобы его хотелось продолжать?'
    ]
  };
}

function getProductLayer(userId, goal) {
  return {
    dailyHint: dailyHintForUser(userId),
    contractTemplates: CONTRACT_TEMPLATES,
    weeklyReview: buildWeeklyReview(userId),
    practices: getPractices(goal)
  };
}

module.exports = { DAILY_HINTS, CONTRACT_TEMPLATES, PRACTICE_GOALS, PRACTICES_BY_GOAL, dailyHintForUser, getPractices, buildWeeklyReview, getProductLayer };
