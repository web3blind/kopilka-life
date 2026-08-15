const { getWeekSummary } = require('./entriesService');
const { getCurrentContract, getLatestContract } = require('./contractsService');
const { normalizeLocale, pick, t, DAILY_HINTS, CONTRACT_TEMPLATES, PRACTICE_GOALS, PRACTICES_BY_GOAL } = require('../i18n');

function dailyHintForUser(userId, locale) {
  const dayIndex = Math.floor(Date.now() / 86400000);
  const hint = DAILY_HINTS[(Number(userId) + dayIndex) % DAILY_HINTS.length];
  const lang = normalizeLocale(locale);
  return { id: hint.id, title: pick(hint.title, lang), text: pick(hint.text, lang), action: pick(hint.action, lang) };
}

function getContractTemplates(locale) {
  const lang = normalizeLocale(locale);
  return CONTRACT_TEMPLATES.map((item) => ({
    id: item.id,
    title: pick(item.title, lang),
    targetValue: pick(item.targetValue, lang),
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
    contractTemplates: getContractTemplates(locale),
    weeklyReview: buildWeeklyReview(userId, locale),
    practices: getPractices(goal, locale)
  };
}

module.exports = { getContractTemplates, getPractices, buildWeeklyReview, getProductLayer, dailyHintForUser };
