const express = require('express');
const config = require('../config');
const { validateTelegramInitData } = require('../auth/validateTelegramInitData');
const { validateTelegramLogin } = require('../auth/validateTelegramLogin');
const { validateVkLaunchParams } = require('../auth/validateVkLaunchParams');
const { createToken, verifyToken } = require('../auth/session');
const { publicUser, upsertTelegramUser, upsertVkUser, linkVkUser, createDemoUser, getUserById, updateLocale, updateSettings, deleteDemoUser } = require('../services/usersService');
const { grantReferrerBonusOnFirstEntry, profileStats, publicProfileByCode } = require('../services/referralService');
const { createEntry, getSummary, getWeekSummary, listEntries } = require('../services/entriesService');
const { getCurrentContract, createContract, closeContract } = require('../services/contractsService');
const { scheduleNextReminderForUser } = require('../services/remindersService');
const { getProductLayer, getPractices } = require('../services/productContentService');
const { createRateLimiter } = require('../middleware/rateLimit');
const { normalizeLocale, t } = require('../i18n');

const router = express.Router();
const authLimiter = createRateLimiter({ windowMs: config.rateLimits.authWindowMs, max: config.rateLimits.authMax, keyPrefix: 'auth' });
const devLimiter = createRateLimiter({ windowMs: config.rateLimits.devWindowMs, max: config.rateLimits.devMax, keyPrefix: 'dev' });

// Translate an error message thrown as an i18n key (or pass through plain text).
function userError(locale, message) {
  if (typeof message === 'string' && message.startsWith('error.') && t(locale, message) !== message) {
    return t(locale, message);
  }
  return message;
}

function authRequired(req, res, next) {
  const userId = verifyToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!userId) return res.status(401).json({ error: t(req.locale || 'ru', 'error.session') });
  const user = getUserById(userId);
  if (!user) return res.status(401).json({ error: t(req.locale || 'ru', 'error.userNotFound') });
  req.user = user;
  req.locale = normalizeLocale(user.locale);
  return next();
}
function disabled(res) { return res.status(404).json({ error: 'disabled' }); }

router.post('/auth/telegram', authLimiter, (req, res) => {
  try {
    const validated = validateTelegramInitData(req.body.initData, config.botToken, { maxAgeSeconds: config.telegramAuthMaxAgeSeconds });
    const user = upsertTelegramUser(validated.user, req.body.refCode, req.body.timezone);
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    console.error('[auth/telegram] reject:', error && error.message ? error.message : String(error));
    res.status(401).json({ error: 'Не удалось подтвердить Telegram-сессию. Открой приложение из Telegram ещё раз.' });
  }
});
// Site login via Telegram Login Widget. Same account as Mini App (keyed by telegram_id).
router.post('/auth/telegram-login', authLimiter, (req, res) => {
  try {
    const validated = validateTelegramLogin(req.body, config.botToken, { maxAgeSeconds: config.telegramAuthMaxAgeSeconds });
    const user = upsertTelegramUser(validated.user, req.body.refCode, req.body.timezone);
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    res.status(401).json({ error: 'Не удалось подтвердить вход через Telegram.' });
  }
});
router.post('/auth/vk', authLimiter, (req, res) => {
  try {
    const validated = validateVkLaunchParams(req.body.launchParams, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    const user = upsertVkUser(validated.vkId, req.body.refCode, req.body.timezone, validated.language || req.body.locale || 'ru');
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    console.error('[auth/vk] reject:', error && error.message ? error.message : String(error));
    res.status(401).json({ error: 'Не удалось подтвердить VK-сессию. Открой приложение из VK ещё раз.' });
  }
});
router.post('/settings/link-vk', authRequired, authLimiter, (req, res) => {
  try {
    const validated = validateVkLaunchParams(req.body.launchParams, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    const user = linkVkUser(req.user.id, validated.vkId);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('[settings/link-vk] reject:', error && error.message ? error.message : String(error));
    res.status(400).json({ error: error.message || 'Не удалось привязать VK.' });
  }
});
// Public, non-sensitive config the site needs to render sign-in options.
router.get('/config', (req, res) => res.json({ botUsername: config.botUsername, webappUrl: config.webappUrl, telegramLoginWidgetEnabled: config.telegramLoginWidgetEnabled, vkAppId: config.vkAppId }));
router.post('/auth/dev', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  const user = createDemoUser(req.body.firstName || 'Demo', req.body.locale, req.body.refCode, req.body.timezone);
  return res.json({ token: createToken(user.id), user: publicUser(user) });
});
router.delete('/dev/demo-user/:id', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  return res.json({ deleted: deleteDemoUser(Number(req.params.id)) });
});
router.get('/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));
router.get('/profile', authRequired, (req, res) => {
  const stats = profileStats(req.user.id);
  const botLink = config.botUsername ? `https://t.me/${config.botUsername.replace(/^@/, '')}?startapp=${stats.refCode}` : null;
  res.json({ profile: { ...publicUser(req.user), ...stats, refLink: `${config.webappUrl}?ref=${stats.refCode}`, profileLink: `${config.webappUrl}/p/${stats.refCode}`, botLink } });
});
router.get('/public/:code', (req, res) => {
  const profile = publicProfileByCode(req.params.code);
  if (!profile) return res.status(404).json({ error: 'not found' });
  res.json({ profile });
});
router.post('/settings/locale', authRequired, (req, res) => {
  const user = updateLocale(req.user.id, req.body.locale);
  res.json({ user: publicUser(user) });
});
router.get('/summary/today', authRequired, (req, res) => res.json(getSummary(req.user.id)));
router.post('/entries', authRequired, (req, res) => {
  try {
    const entry = createEntry(req.user.id, req.body.type, req.body.note || '', req.locale);
    grantReferrerBonusOnFirstEntry(req.user.id);
    res.status(201).json({ entry, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
router.get('/entries', authRequired, (req, res) => {
  if (req.query.range === 'week') return res.json(getWeekSummary(req.user.id));
  return res.json({ entries: listEntries(req.user.id, req.query.range || 'today') });
});
router.get('/product', authRequired, (req, res) => res.json(getProductLayer(req.user.id, req.query.goal, req.locale)));
router.get('/product/practices', authRequired, (req, res) => res.json(getPractices(req.query.goal, req.locale)));
router.get('/contracts/current', authRequired, (req, res) => res.json({ contract: getCurrentContract(req.user.id) }));
router.post('/contracts', authRequired, (req, res) => {
  try { res.status(201).json({ contract: createContract(req.user.id, req.body) }); }
  catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
router.post('/contracts/:id/close', authRequired, (req, res) => {
  try {
    const contract = closeContract(req.user.id, Number(req.params.id), req.body.status, req.body.resultNote || '');
    res.json({ contract, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
router.post('/settings/reminders', authRequired, (req, res) => {
  const user = updateSettings(req.user.id, req.body);
  scheduleNextReminderForUser(req.user.id, { replace: true });
  res.json({ user: publicUser(user) });
});
module.exports = router;
