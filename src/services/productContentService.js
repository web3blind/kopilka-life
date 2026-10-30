const { getWeekSummary } = require('./entriesService');
const { getCurrentContract, getLatestContract } = require('./contractsService');
const { normalizeLocale, pick, t, DAILY_HINTS, CONTRACT_TEMPLATES, PRACTICE_GOALS, PRACTICES_BY_GOAL } = require('../i18n');
const { localDateString } = require('../time');
const { getDb } = require('../db');

function contractDaysForUser(userId, now = new Date()) {
  const timezone = userId ? getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId)?.timezone : 'UTC';
  const weekday = new Date(`${localDateString(now, timezone || 'UTC')}T12:00:00Z`).getUTCDay();
  // Sunday creates a next-week contract, not a one-day contract.
  return weekday === 0 ? 7 : 8 - weekday;
}

function dailyHintForUser(userId, locale) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const hint = DAILY_HINTS[(Number(userId) + dayIndex) % DAILY_HINTS.length];
  const lang = normalizeLocale(locale);
  return { id: hint.id, title: pick(hint.title, lang), text: pick(hint.text, lang), action: pick(hint.action, lang) };
}

function getContractTemplates(locale, userId, now = new Date()) {
  const lang = normalizeLocale(locale);
  const restDays = Math.min(3, contractDaysForUser(userId, now));
  return CONTRACT_TEMPLATES.map((item) => ({
    id: item.id,
    title: pick(item.title, lang),
    targetValue: pick(item.targetValue, lang).replace('{days}', restDays),
    stakeAmount: '',
    stakeCurrency: 'RUB',
    rewardDescription: pick(item.rewardDescription, lang),
    fundDescription: pick(item.fundDescription, lang)
  }));
}

function getPractices(goal = 'calm', locale) {
  const lang = normalizeLocale(locale);
  const normalized = PRACTICES_BY_GOAL[goal] ? goal : 'calm';
  return {
    goal: normalized,
    goals: PRACTICE_GOALS.map((g) => ({ id: g.id, title: pick(g.title, lang) })),
    practices: PRACTICES_BY_GOAL[normalized].map((p) => pick(p, lang))
  };
}

function buildWeeklyReview(userId, locale) {
  const lang = normalizeLocale(locale);
  const week = getWeekSummary(userId);
  const currentContract = getCurrentContract(userId);
  const latestContract = currentContract || getLatestContract(userId);
  const top = week.topCategories[0]?.title;
  const parts = [];
  if (week.activeDays === 0) parts.push(t(lang, 'review.quietWeek'));
  else parts.push(t(lang, 'review.weekSummary', { days: week.activeDays, life: week.weekLife }));
  if (top) parts.push(t(lang, 'review.topCategory', { top }));
  if (latestContract) {
    parts.push(currentContract
      ? t(lang, 'review.activeContract', { title: latestContract.title })
      : t(lang, 'review.lastContract', { status: t(lang, `review.closeStatus.${latestContract.status}`) }));
  } else {
    parts.push(t(lang, 'review.noContract'));
  }
  return {
    summaryText: parts.join(' '),
    activeDays: week.activeDays,
    weekLife: week.weekLife,
    topCategory: top || null,
    contract: latestContract ? { ...latestContract, title: latestContract.title } : null,
    questions: [t(lang, 'review.q1'), t(lang, 'review.q2'), t(lang, 'review.q3')]
  };
}

function getProductLayer(userId, goal, locale) {
  return {
    dailyHint: dailyHintForUser(userId, locale),
    contractTemplates: getContractTemplates(locale, userId),
    contractDays: contractDaysForUser(userId),
    weeklyReview: buildWeeklyReview(userId, locale),
    practices: getPractices(goal, locale)
  };
}

module.exports = { getContractTemplates, getPractices, buildWeeklyReview, getProductLayer, dailyHintForUser };
