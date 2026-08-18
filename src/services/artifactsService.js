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
    triggerText: 'появляется, если за неделю были и встреча или звонок, и время с родными',
    unlockedText: 'Соловей Близких Голосов пропел тихо: хорошо, что ты был не один. Друг, подруга, родные — это тоже жизнь.',
    lockedText: 'Он прилетает после недели, где нашлось место и друзьям, и родным.',
    image: '/assets/artifacts/nightingale_close_voices.webp',
    alt: 'Небольшая поющая птица сидит на ветке; на крыльях и груди мягкие сердечные узоры.',
    sortOrder: 30,
    condition: ({ recentTypes }) => recentTypes.has('social_contact') && recentTypes.has('family_time')
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
    id: 'bear_warm_shelter',
    title: 'Медведь Тёплого Укрытия',
    shortTitle: 'После трудного дня',
    triggerText: 'появляется, когда после трудного дня ты снова сделал любую запись',
    unlockedText: 'Медведь Тёплого Укрытия сел рядом. Он ничего не требует. Просто держит место, где можно переждать холод.',
    lockedText: 'Он приходит не за идеальный день, а за возвращение после сложного.',
    image: '/assets/artifacts/bear_warm_shelter.webp',
    alt: 'Большой добрый медведь сидит с тёплым пледом и маленьким фонарём; в пледе видны сердечные узоры.',
    sortOrder: 50,
    condition: ({ hasEntryAfterHardDay }) => hasEntryAfterHardDay
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
      triggerText: 'Пользуйся Копилкой жизни, отмечай через быстрые кнопки то, что происходит в твоей жизни — и однажды здесь появится персонаж.',
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
  const recentTypes = new Set(db.prepare('SELECT DISTINCT type FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?').all(userId, since, today).map((row) => row.type));
  const hard = db.prepare("SELECT id, created_at FROM entries WHERE user_id = ? AND type = 'hard_day' ORDER BY created_at ASC, id ASC LIMIT 1").get(userId);
  const afterHard = hard ? db.prepare('SELECT id FROM entries WHERE user_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) AND id <> ? LIMIT 1').get(userId, hard.created_at, hard.created_at, hard.id, hard.id) : null;
  return { totalLife, counts, recentTypes, hasEntryAfterHardDay: Boolean(afterHard) };
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
