const { getDb } = require('../db');
const { localDateString } = require('../time');
const { normalizeLocale, t } = require('../i18n');

const RECOVERY_BONUS_TOTAL = 20;
const FOOD_WATER_MARKS = 4;
const FOOD_WATER_POINTS = 1;
const RECOVERY_ENTRY_POINTS = RECOVERY_BONUS_TOTAL - FOOD_WATER_MARKS * FOOD_WATER_POINTS;
// Seven-day recovery window after the 2026-08-25 incident, through 2026-09-01 NSK.
const RECOVERY_ACTIVE_UNTIL = new Date(process.env.RECOVERY_BONUS_UNTIL || '2026-09-02T00:00:00+07:00');

function userTimezone(userId) {
  return getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone || 'Asia/Novosibirsk';
}

function shiftLocalDate(dateString, deltaDays) {
  const date = new Date(`${dateString}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function recoveryNotice(locale = 'ru') {
  const lang = normalizeLocale(locale);
  return {
    type: 'recovery_bonus',
    points: RECOVERY_BONUS_TOTAL,
    foodWaterMarks: FOOD_WATER_MARKS,
    title: lang === 'en' ? 'Recovery bonus' : 'Восстановительный бонус',
    message: lang === 'en'
      ? 'There was a technical incident, and some activity may have been lost. To make returning feel a little warmer, we added +20 LIFE and 4 food/water marks — a small acknowledgement that you were living before opening the app too.'
      : 'Произошёл технический сбой, и часть активности могла потеряться. Чтобы возвращаться было приятнее, мы добавили +20 ЖИЗНЬ и 4 отметки «Еда или вода» — как признание того, что до входа в приложение вы тоже жили.'
  };
}

function maybeGrantRecoveryBonus(userId, locale = 'ru', now = new Date()) {
  if (now >= RECOVERY_ACTIVE_UNTIL) return null;
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(userId);
  if (existing.count > 0 || existing.total > 0) return null;

  const lang = normalizeLocale(locale);
  const timezone = userTimezone(userId);
  const today = localDateString(now, timezone);
  const foodTitle = t(lang, 'entry.food_water.title');
  const note = lang === 'en'
    ? 'A recovery mark after the technical incident: life was happening before the app opened too.'
    : 'Восстановительная отметка после технического сбоя: жизнь была и до входа в приложение.';
  const bonusTitle = lang === 'en' ? 'Recovery bonus' : 'Восстановительный бонус';
  const bonusNote = lang === 'en'
    ? 'Added after the technical incident, so the first steps do not feel reset.'
    : 'Начислено после технического сбоя, чтобы первые шаги не казались обнулёнными.';

  return db.transaction(() => {
    const afterLock = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(life_points), 0) AS total FROM entries WHERE user_id = ?').get(userId);
    if (afterLock.count > 0 || afterLock.total > 0) return null;
    db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'recovery_bonus', ?, ?, ?, ?)")
      .run(userId, bonusTitle, bonusNote, RECOVERY_ENTRY_POINTS, today);
    for (let i = FOOD_WATER_MARKS; i >= 1; i -= 1) {
      db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'food_water', ?, ?, ?, ?)")
        .run(userId, foodTitle, note, FOOD_WATER_POINTS, shiftLocalDate(today, -i));
    }
    return recoveryNotice(lang);
  })();
}

module.exports = { maybeGrantRecoveryBonus, recoveryNotice, RECOVERY_BONUS_TOTAL, FOOD_WATER_MARKS, RECOVERY_ACTIVE_UNTIL };
