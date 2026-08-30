const { getDb } = require('../db');
const { localDateString } = require('../time');

const DAY_MS = 24 * 60 * 60 * 1000;

const ARTIFACTS = [
  {
    id: 'cat_life_warmer',
    title: 'Кот Жизнелюб',
    shortTitle: 'Первое тепло',
    triggerText: 'появляется, когда в копилке набирается 12 ЖИЗНЬ',
    unlockedText: 'Кот Жизнелюб пришёл первым. Он устроился рядом и напомнил: маленькие добрые действия уже считаются.',
    lockedText: 'Этот кот приходит, когда в копилке появится первое заметное тепло.',
    image: '/assets/artifacts/cat_life_warmer.webp',
    alt: 'Пушистый улыбающийся рыжий кот с большим сердцем на груди сидит в тёплом золотом свете.',
    sortOrder: 10,
    condition: ({ totalLife }) => totalLife >= 12
  },
  {
    id: 'dog_steady_step',
    title: 'Пёс Верный Шаг',
    shortTitle: 'Путь продолжается',
    triggerText: 'появляется на 50 ЖИЗНЬ',
    unlockedText: 'Пёс Верный Шаг пошёл рядом. Он не торопит и не тянет вперёд — просто держит темп.',
    lockedText: 'Он встретит тебя, когда маленьких шагов станет уже много.',
    image: '/assets/artifacts/dog_steady_step.webp',
    alt: 'Добрый пёс идёт рядом со светящимися следами; на ошейнике маленькое сердце.',
    sortOrder: 20,
    condition: ({ totalLife }) => totalLife >= 50
  },
  {
    id: 'nightingale_close_voices',
    title: 'Соловей Близких Голосов',
    shortTitle: 'Связь с людьми',
    triggerText: 'появляется после нескольких отметок общения и времени с родными за неделю',
    unlockedText: 'Соловей Близких Голосов пропел тихо: хорошо, что ты не терял связь с людьми. Друг, подруга, родные — это тоже жизнь.',
    lockedText: 'Он прилетает после недели, где несколько раз нашлось место и друзьям, и родным.',
    image: '/assets/artifacts/nightingale_close_voices.webp',
    alt: 'Небольшая поющая птица сидит на ветке; на крыльях и груди мягкие сердечные узоры.',
    sortOrder: 30,
    condition: ({ recentCounts }) => (
      (recentCounts.social_contact || 0) >= 1
      && (recentCounts.family_time || 0) >= 1
      && ((recentCounts.social_contact || 0) + (recentCounts.family_time || 0)) >= 3
    )
  },
  {
    id: 'sloth_rest_blessing',
    title: 'Ленивец отдыха',
    shortTitle: 'Отдых засчитан',
    triggerText: 'появляется после трёх отметок отдыха',
    unlockedText: 'Ленивец отдыха поднял лапу и одобрил паузу. Восстанавливаться — не пропускать жизнь, а беречь её.',
    lockedText: 'Он появляется у тех, кто разрешил себе отдых не один раз.',
    image: '/assets/artifacts/sloth_rest_blessing.webp',
    alt: 'Спокойный ленивец отдыхает на ветке с маленькой подушкой; вокруг листья в форме сердец.',
    sortOrder: 40,
    condition: ({ counts }) => (counts.rest || 0) >= 3
  },
  {
    id: 'hedgehog_small_joy',
    title: 'Ёжик Радостной Мелочи',
    shortTitle: 'Радость заметили',
    triggerText: 'появляется после четырёх дней, где ты отметил радость',
    unlockedText: 'Ёжик Радостной Мелочи вышел навстречу и принёс светящуюся ягоду. Он рад, что ты замечал хорошее — даже маленькое.',
    lockedText: 'Он появляется у тех, кто несколько дней замечал радость.',
    image: '/assets/artifacts/hedgehog_small_joy.webp',
    alt: 'Маленький радостный ёжик держит светящуюся ягоду; вокруг тёплый свет и сердечки.',
    sortOrder: 45,
    condition: ({ distinctDaysByType }) => (distinctDaysByType.joy || 0) >= 4
  },
  {
    id: 'bee_good_deed_honey',
    title: 'Пчела Доброделка',
    shortTitle: 'Мёд за добрые дела',
    triggerText: 'появляется после трёх добрых дел',
    unlockedText: 'Пчела Доброделка прилетела с баночкой мёда. Она сказала: добрые дела не исчезают, они где-то становятся теплом.',
    lockedText: 'Она прилетает к тем, кто несколько раз оставил добрый след.',
    image: '/assets/artifacts/bee_good_deed_honey.webp',
    alt: 'Добрая улыбающаяся пчела держит баночку золотого мёда с сердцем.',
    sortOrder: 47,
    condition: ({ counts }) => (counts.kind_trace || 0) >= 3
  },
  {
    id: 'gratitude_helper',
    title: 'Благодарчик',
    shortTitle: 'Тепло благодарности',
    triggerText: 'появляется после восьми отправленных благодарностей дня',
    unlockedText: 'Благодарчик тихо появился рядом и принёс вам тепло. «Будьте счастливы», — сказал он.',
    lockedText: 'Он приходит к тем, кто несколько раз отправлял благодарность дня текстом.',
    image: '/assets/artifacts/gratitude_helper.webp',
    alt: 'Маленький пушистый золотистый Благодарчик в зелёном шарфике держит светящуюся искру тепла.',
    sortOrder: 48,
    condition: ({ counts }) => (counts.gratitude || 0) >= 8
  },
  {
    id: 'contract_keeper',
    title: 'Договорёнок',
    shortTitle: 'Обещание держится',
    triggerText: 'появляется после четырёх выполненных недельных договоров',
    unlockedText: 'Договорёнок тихо вышел навстречу и завязал мягкую ленточку. Он напомнил: договор с собой может быть не наказанием, а поддержкой.',
    lockedText: 'Он приходит к тем, кто несколько недель подряд возвращался к договору с собой и доводил его до результата.',
    image: '/assets/artifacts/contract_keeper.webp',
    alt: 'Маленький пушистый Договорёнок с добрыми глазами держит мягкий зелёный бант как знак выполненного обещания.',
    sortOrder: 49,
    condition: ({ completedContracts }) => completedContracts >= 4
  },
  {
    id: 'bear_warm_shelter',
    title: 'Медведь Тёплого Укрытия',
    shortTitle: 'После трудного дня',
    triggerText: 'появляется после трёх сложных дней и нового шага после них',
    unlockedText: 'Медведь Тёплого Укрытия сел рядом. Он ничего не требует. Просто держит место, где можно переждать холод.',
    lockedText: 'Он приходит не за идеальный день, а за возвращение после нескольких сложных дней.',
    image: '/assets/artifacts/bear_warm_shelter.webp',
    alt: 'Большой добрый медведь сидит с тёплым пледом и маленьким фонарём; в пледе видны сердечные узоры.',
    sortOrder: 50,
    condition: ({ hasEntryAfterThirdHardDay }) => hasEntryAfterThirdHardDay
  },
  {
    id: 'dragon_life_mother',
    title: 'Дракон Матери-Жизни',
    shortTitle: 'Большая защита',
    triggerText: 'редкая встреча на 777 ЖИЗНЬ',
    unlockedText: 'Дракон Матери-Жизни поднял тебя над бурей. На его крыльях — дни, когда ты всё равно выбирал жить.',
    lockedText: 'Эта встреча ждёт далеко впереди. Не надо спешить.',
    image: '/assets/artifacts/dragon_life_mother.webp',
    alt: 'Большой добрый дракон с сердцами на крыльях и животе держит тёплый свет над облаками.',
    sortOrder: 60,
    condition: ({ totalLife }) => totalLife >= 777
  }
];

function publicArtifact(artifact, awarded = null) {
  if (!awarded) {
    return {
      id: `mystery_${artifact.sortOrder}`,
      title: 'Неизвестная встреча',
      shortTitle: 'Пока скрыто',
      triggerText: 'Пользуйся Копилкой жизни, отмечай то, что происходит, и отправляй благодарности — однажды здесь появится персонаж.',
      unlockedText: '',
      lockedText: 'Здесь пока тёмное место. Кто появится — станет понятно только после встречи.',
      image: '',
      alt: 'Закрытое тёмное место для будущего персонажа.',
      sortOrder: artifact.sortOrder,
      unlocked: false,
      awardedAt: null
    };
  }
  return {
    id: artifact.id,
    title: artifact.title,
    shortTitle: artifact.shortTitle,
    triggerText: artifact.triggerText,
    unlockedText: artifact.unlockedText,
    lockedText: artifact.lockedText,
    image: artifact.image,
    alt: artifact.alt,
    sortOrder: artifact.sortOrder,
    unlocked: Boolean(awarded),
    awardedAt: awarded?.awarded_at || null
  };
}

function artifactState(userId) {
  const db = getDb();
  const user = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId);
  const timezone = user?.timezone || 'UTC';
  const today = localDateString(new Date(), timezone);
  const since = localDateString(new Date(Date.now() - 6 * DAY_MS), timezone);
  const totalLife = db.prepare('SELECT COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(userId).total;
  const rows = db.prepare('SELECT type, COUNT(*) AS count FROM entries WHERE user_id = ? GROUP BY type').all(userId);
  const counts = Object.fromEntries(rows.map((row) => [row.type, row.count]));
  const dayRows = db.prepare('SELECT type, COUNT(DISTINCT entry_date) AS count FROM entries WHERE user_id = ? GROUP BY type').all(userId);
  const distinctDaysByType = Object.fromEntries(dayRows.map((row) => [row.type, row.count]));
  const recentCountsRows = db.prepare('SELECT type, COUNT(*) AS count FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ? GROUP BY type').all(userId, since, today);
  const recentCounts = Object.fromEntries(recentCountsRows.map((row) => [row.type, row.count]));
  const completedContracts = db.prepare("SELECT COUNT(*) AS count FROM weekly_contracts WHERE user_id = ? AND status = 'completed'").get(userId).count;
  const thirdHard = db.prepare("SELECT id, created_at FROM entries WHERE user_id = ? AND type = 'hard_day' ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET 2").get(userId);
  const afterThirdHard = thirdHard ? db.prepare('SELECT id FROM entries WHERE user_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) AND id <> ? LIMIT 1').get(userId, thirdHard.created_at, thirdHard.created_at, thirdHard.id, thirdHard.id) : null;
  return { totalLife, counts, distinctDaysByType, recentCounts, completedContracts, hasEntryAfterThirdHardDay: Boolean(afterThirdHard) };
}

function listArtifacts(userId) {
  const db = getDb();
  const awarded = new Map(db.prepare('SELECT artifact_id, awarded_at FROM user_artifacts WHERE user_id = ?').all(userId).map((row) => [row.artifact_id, row]));
  return ARTIFACTS.map((artifact) => publicArtifact(artifact, awarded.get(artifact.id)));
}

function awardArtifactsForUser(userId, triggerEntryId = null) {
  const db = getDb();
  const state = artifactState(userId);
  const already = new Set(db.prepare('SELECT artifact_id FROM user_artifacts WHERE user_id = ?').all(userId).map((row) => row.artifact_id));
  const newly = [];
  const tx = db.transaction(() => {
    ARTIFACTS.forEach((artifact) => {
      if (already.has(artifact.id) || !artifact.condition(state)) return;
      db.prepare('INSERT OR IGNORE INTO user_artifacts (user_id, artifact_id, trigger_entry_id) VALUES (?, ?, ?)').run(userId, artifact.id, triggerEntryId);
      const row = db.prepare('SELECT artifact_id, awarded_at FROM user_artifacts WHERE user_id = ? AND artifact_id = ?').get(userId, artifact.id);
      if (row) newly.push(publicArtifact(artifact, row));
    });
  });
  tx();
  return newly;
}

function artifactSummary(userId) {
  const artifacts = listArtifacts(userId);
  return {
    total: artifacts.length,
    unlocked: artifacts.filter((item) => item.unlocked).length,
    latest: artifacts.filter((item) => item.unlocked).sort((a, b) => String(b.awardedAt).localeCompare(String(a.awardedAt))).slice(0, 3)
  };
}

module.exports = { ARTIFACTS, listArtifacts, awardArtifactsForUser, artifactSummary };
