const { getDb } = require('../db');
const { localDateString } = require('../time');

const DAY_MS = 24 * 60 * 60 * 1000;

const ARTIFACTS = [
  {
    id: 'cat_life_warmer',
    title: { ru: 'Кот Жизнелюб', en: 'Life-loving Cat' },
    shortTitle: { ru: 'Первое тепло', en: 'First warmth' },
    triggerText: { ru: 'Встреча случилась, когда в копилке набралось 12 ЖИЗНЬ.', en: 'The encounter happened when your harbor reached 12 LIFE.' },
    unlockedText: { ru: 'Кот Жизнелюб пришёл первым. Он устроился рядом и напомнил: маленькие добрые действия уже считаются.', en: 'The Life-loving Cat arrived first. He settled nearby and reminded you: small caring actions already count.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/cat_life_warmer.webp',
    alt: { ru: 'Пушистый улыбающийся рыжий кот с большим сердцем на груди сидит в тёплом золотом свете.', en: 'A fluffy smiling ginger cat with a large heart on his chest sits in warm golden light.' },
    sortOrder: 10,
    condition: ({ totalLife }) => totalLife >= 12
  },
  {
    id: 'dog_steady_step',
    title: { ru: 'Пёс Верный Шаг', en: 'Steady Step Dog' },
    shortTitle: { ru: 'Путь продолжается', en: 'The path continues' },
    triggerText: { ru: 'Встреча случилась на 50 ЖИЗНЬ.', en: 'The encounter happened at 50 LIFE.' },
    unlockedText: { ru: 'Пёс Верный Шаг пошёл рядом. Он не торопит и не тянет вперёд — просто держит темп.', en: 'The Steady Step Dog joined you. He neither rushes nor pulls ahead; he simply keeps pace.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/dog_steady_step.webp',
    alt: { ru: 'Добрый пёс идёт рядом со светящимися следами; на ошейнике маленькое сердце.', en: 'A kind dog walks beside glowing footprints with a small heart on his collar.' },
    sortOrder: 20,
    condition: ({ totalLife }) => totalLife >= 50
  },
  {
    id: 'nightingale_close_voices',
    title: { ru: 'Соловей Близких Голосов', en: 'Nightingale of Close Voices' },
    shortTitle: { ru: 'Связь с людьми', en: 'Connection with people' },
    triggerText: { ru: 'Встреча случилась после недели, где нашлось место общению с друзьями и родными.', en: 'The encounter happened after a week that made room for friends and family.' },
    unlockedText: { ru: 'Соловей Близких Голосов пропел тихо: хорошо, что ты не терял связь с людьми. Друг, подруга, родные — это тоже жизнь.', en: 'The Nightingale of Close Voices sang softly: it is good that you stayed connected. Friends and family are part of life too.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/nightingale_close_voices.webp',
    alt: { ru: 'Небольшая поющая птица сидит на ветке; на крыльях и груди мягкие сердечные узоры.', en: 'A small singing bird sits on a branch with soft heart patterns on its wings and chest.' },
    sortOrder: 30,
    condition: ({ recentCounts }) => (
      (recentCounts.social_contact || 0) >= 1
      && (recentCounts.family_time || 0) >= 1
      && ((recentCounts.social_contact || 0) + (recentCounts.family_time || 0)) >= 3
    )
  },
  {
    id: 'sloth_rest_blessing',
    title: { ru: 'Ленивец отдыха', en: 'Resting Sloth' },
    shortTitle: { ru: 'Отдых засчитан', en: 'Rest has been noticed' },
    triggerText: { ru: 'Встреча случилась после трёх отметок отдыха.', en: 'The encounter happened after three rest entries.' },
    unlockedText: { ru: 'Ленивец отдыха поднял лапу и одобрил паузу. Восстанавливаться — не пропускать жизнь, а беречь её.', en: 'The Resting Sloth raised a paw in approval of the pause. Recovery is not missing life; it is caring for it.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/sloth_rest_blessing.webp',
    alt: { ru: 'Спокойный ленивец отдыхает на ветке с маленькой подушкой; вокруг листья в форме сердец.', en: 'A calm sloth rests on a branch with a small pillow, surrounded by heart-shaped leaves.' },
    sortOrder: 40,
    condition: ({ counts }) => (counts.rest || 0) >= 3
  },
  {
    id: 'hedgehog_small_joy',
    title: { ru: 'Ёжик Радостной Мелочи', en: 'Hedgehog of Small Joys' },
    shortTitle: { ru: 'Радость заметили', en: 'Joy was noticed' },
    triggerText: { ru: 'Встреча случилась после четырёх дней с отмеченной радостью.', en: 'The encounter happened after joy was noticed on four days.' },
    unlockedText: { ru: 'Ёжик Радостной Мелочи вышел навстречу и принёс светящуюся ягоду. Он рад, что ты замечал хорошее — даже маленькое.', en: 'The Hedgehog of Small Joys came out to meet you with a glowing berry. He is glad you noticed good things, even tiny ones.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/hedgehog_small_joy.webp',
    alt: { ru: 'Маленький радостный ёжик держит светящуюся ягоду; вокруг тёплый свет и сердечки.', en: 'A small joyful hedgehog holds a glowing berry amid warm light and hearts.' },
    sortOrder: 45,
    condition: ({ distinctDaysByType }) => (distinctDaysByType.joy || 0) >= 4
  },
  {
    id: 'savoring_beaver',
    title: { ru: 'Бобр Наслаждения', en: 'Savoring Beaver' },
    shortTitle: { ru: 'Пять тёплых моментов', en: 'Five warm moments' },
    triggerText: { ru: 'Встреча случилась после пяти отметок «Наслаждение».', en: 'The encounter happened after five Savoring entries.' },
    unlockedText: { ru: 'Бобр Наслаждения выбрался к тёплой воде и поднял чашку. Вокруг него зажглись пять тёплых капель — за вкус, тепло, запах, звук и красивый момент, которые вы успели заметить.', en: 'The Savoring Beaver came to the warm water and raised a cup. Five warm drops lit up around him for tastes, warmth, scents, sounds, and beautiful moments you noticed.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/savoring_beaver.webp',
    alt: { ru: 'Милый бобр у тёплой воды держит маленькую чашку; вокруг светятся пять золотых капель наслаждения моментом.', en: 'A sweet beaver by warm water holds a small cup while five golden drops glow around him.' },
    sortOrder: 46,
    condition: ({ counts }) => (counts.savoring || 0) >= 5
  },
  {
    id: 'bee_good_deed_honey',
    title: { ru: 'Пчела Доброделка', en: 'Kind Deed Bee' },
    shortTitle: { ru: 'Мёд за добрые дела', en: 'Honey for kind deeds' },
    triggerText: { ru: 'Встреча случилась после трёх добрых дел.', en: 'The encounter happened after three kind deeds.' },
    unlockedText: { ru: 'Пчела Доброделка прилетела с баночкой мёда. Она сказала: добрые дела не исчезают, они где-то становятся теплом.', en: 'The Kind Deed Bee arrived with a jar of honey. She said: kind deeds do not disappear; somewhere, they become warmth.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/bee_good_deed_honey.webp',
    alt: { ru: 'Добрая улыбающаяся пчела держит баночку золотого мёда с сердцем.', en: 'A kind smiling bee holds a jar of golden honey with a heart.' },
    sortOrder: 47,
    condition: ({ counts }) => (counts.kind_trace || 0) >= 3
  },
  {
    id: 'gratitude_helper',
    title: { ru: 'Благодарчик', en: 'Gratitude Helper' },
    shortTitle: { ru: 'Тепло благодарности', en: 'The warmth of gratitude' },
    triggerText: { ru: 'Встреча случилась после восьми благодарностей дня.', en: 'The encounter happened after eight daily gratitude notes.' },
    unlockedText: { ru: 'Благодарчик тихо появился рядом и принёс вам тепло. «Будьте счастливы», — сказал он.', en: 'The Gratitude Helper quietly appeared and brought you warmth. “May you be happy,” he said.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/gratitude_helper.webp',
    alt: { ru: 'Маленький пушистый золотистый Благодарчик в зелёном шарфике держит светящуюся искру тепла.', en: 'A small fluffy golden Gratitude Helper in a green scarf holds a glowing spark of warmth.' },
    sortOrder: 48,
    condition: ({ counts }) => (counts.gratitude || 0) >= 8
  },
  {
    id: 'contract_keeper',
    title: { ru: 'Черепаха Тихого Договора', en: 'Quiet Contract Turtle' },
    shortTitle: { ru: 'Четыре недели пути', en: 'Four weeks on the path' },
    triggerText: { ru: 'Встреча случилась после четырёх выполненных недельных договоров.', en: 'The encounter happened after four completed weekly contracts.' },
    unlockedText: { ru: 'Черепаха Тихого Договора медленно вышла навстречу. На её панцире зажглись четыре тёплых знака — по одному за каждую неделю, где договор с собой стал поддержкой, а не наказанием.', en: 'The Quiet Contract Turtle slowly came to meet you. Four warm marks lit up on her shell, one for each week when a promise to yourself became support rather than punishment.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/contract_keeper.webp',
    alt: { ru: 'Милая зелёная черепаха с добрыми глазами; на панцире четыре светлых знака выполненных недель.', en: 'A sweet green turtle with kind eyes and four glowing marks on her shell.' },
    sortOrder: 49,
    condition: ({ completedContracts }) => completedContracts >= 4
  },
  {
    id: 'bear_warm_shelter',
    title: { ru: 'Медведь Тёплого Укрытия', en: 'Warm Shelter Bear' },
    shortTitle: { ru: 'После трудного дня', en: 'After a hard day' },
    triggerText: { ru: 'Встреча случилась после возвращения к жизни вслед за несколькими сложными днями.', en: 'The encounter happened when you returned to life after several hard days.' },
    unlockedText: { ru: 'Медведь Тёплого Укрытия сел рядом. Он ничего не требует. Просто держит место, где можно переждать холод.', en: 'The Warm Shelter Bear sat beside you. He asks for nothing, simply holding a place where you can wait out the cold.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/bear_warm_shelter.webp',
    alt: { ru: 'Большой добрый медведь сидит с тёплым пледом и маленьким фонарём; в пледе видны сердечные узоры.', en: 'A large kind bear sits with a warm blanket and a small lantern; heart patterns are visible on the blanket.' },
    sortOrder: 50,
    condition: ({ hasEntryAfterThirdHardDay }) => hasEntryAfterThirdHardDay
  },
  {
    id: 'dragon_life_mother',
    title: { ru: 'Дракон Матери-Жизни', en: 'Mother-Life Dragon' },
    shortTitle: { ru: 'Большая защита', en: 'Great protection' },
    triggerText: { ru: 'Редкая встреча случилась на 777 ЖИЗНЬ.', en: 'This rare encounter happened at 777 LIFE.' },
    unlockedText: { ru: 'Дракон Матери-Жизни поднял тебя над бурей. На его крыльях — дни, когда ты всё равно выбирал жить.', en: 'The Mother-Life Dragon lifted you above the storm. On his wings are the days when you still chose life.' },
    lockedText: { ru: 'Здесь пока тихо. Новая встреча откроется сама — спешить не нужно.', en: 'It is quiet here for now. A new encounter will open in its own time; there is no need to hurry.' },
    image: '/assets/artifacts/dragon_life_mother.webp',
    alt: { ru: 'Большой добрый дракон с сердцами на крыльях и животе держит тёплый свет над облаками.', en: 'A large kind dragon with hearts on his wings and belly holds warm light above the clouds.' },
    sortOrder: 60,
    condition: ({ totalLife }) => totalLife >= 777
  }
];

function localized(value, locale) {
  if (typeof value === 'string') return value;
  return value?.[locale] || value?.ru || '';
}

function publicArtifact(artifact, awarded = null, locale = 'ru') {
  if (!awarded) {
    const slot = ARTIFACTS.indexOf(artifact) + 1;
    return {
      id: `mystery_${artifact.sortOrder}`,
      title: locale === 'en' ? 'Unknown encounter' : 'Неизвестная встреча',
      shortTitle: locale === 'en' ? `Quiet place ${slot}` : `Тихое место ${slot}`,
      triggerText: locale === 'en' ? 'Keep noticing what supports your life. An encounter may happen in its own time.' : 'Продолжай замечать то, что поддерживает жизнь. Встреча случится в своё время.',
      unlockedText: '',
      lockedText: localized(artifact.lockedText, locale),
      image: '',
      alt: locale === 'en' ? 'A closed quiet place for a future character.' : 'Закрытое тихое место для будущего персонажа.',
      sortOrder: artifact.sortOrder,
      unlocked: false,
      awardedAt: null
    };
  }
  return {
    id: artifact.id,
    title: localized(artifact.title, locale),
    shortTitle: localized(artifact.shortTitle, locale),
    triggerText: localized(artifact.triggerText, locale),
    unlockedText: localized(artifact.unlockedText, locale),
    lockedText: localized(artifact.lockedText, locale),
    image: artifact.image,
    alt: localized(artifact.alt, locale),
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
  const locale = db.prepare('SELECT locale FROM users WHERE id = ?').get(userId)?.locale === 'en' ? 'en' : 'ru';
  const awarded = new Map(db.prepare('SELECT artifact_id, awarded_at FROM user_artifacts WHERE user_id = ?').all(userId).map((row) => [row.artifact_id, row]));
  return ARTIFACTS.map((artifact) => publicArtifact(artifact, awarded.get(artifact.id), locale));
}

function awardArtifactsForUser(userId, triggerEntryId = null) {
  const db = getDb();
  const state = artifactState(userId);
  const locale = db.prepare('SELECT locale FROM users WHERE id = ?').get(userId)?.locale === 'en' ? 'en' : 'ru';
  const already = new Set(db.prepare('SELECT artifact_id FROM user_artifacts WHERE user_id = ?').all(userId).map((row) => row.artifact_id));
  const newly = [];
  const tx = db.transaction(() => {
    ARTIFACTS.forEach((artifact) => {
      if (already.has(artifact.id) || !artifact.condition(state)) return;
      db.prepare('INSERT OR IGNORE INTO user_artifacts (user_id, artifact_id, trigger_entry_id) VALUES (?, ?, ?)').run(userId, artifact.id, triggerEntryId);
      const row = db.prepare('SELECT artifact_id, awarded_at FROM user_artifacts WHERE user_id = ? AND artifact_id = ?').get(userId, artifact.id);
      if (row) newly.push(publicArtifact(artifact, row, locale));
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
