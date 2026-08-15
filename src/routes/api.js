const express = require('express');
const config = require('../config');
const { validateTelegramInitData } = require('../auth/validateTelegramInitData');
const { createToken, verifyToken } = require('../auth/session');
const { publicUser, upsertTelegramUser, createDemoUser, getUserById, updateSettings, deleteDemoUser } = require('../services/usersService');
const { createEntry, getSummary, getWeekSummary, listEntries } = require('../services/entriesService');
const { getCurrentContract, createContract, closeContract } = require('../services/contractsService');
const { scheduleNextReminderForUser } = require('../services/remindersService');
const { getProductLayer, getPractices } = require('../services/productContentService');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const authLimiter = createRateLimiter({ windowMs: config.rateLimits.authWindowMs, max: config.rateLimits.authMax, keyPrefix: 'auth' });
const devLimiter = createRateLimiter({ windowMs: config.rateLimits.devWindowMs, max: config.rateLimits.devMax, keyPrefix: 'dev' });

function authRequired(req, res, next) {
  const userId = verifyToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!userId) return res.status(401).json({ error: 'Не удалось подтвердить сессию. Открой приложение из Telegram ещё раз.' });
  const user = getUserById(userId);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден.' });
  req.user = user;
  return next();
}
function disabled(res) { return res.status(404).json({ error: 'disabled' }); }

router.post('/auth/telegram', authLimiter, (req, res) => {
  try {
    const validated = validateTelegramInitData(req.body.initData, config.botToken, { maxAgeSeconds: config.telegramAuthMaxAgeSeconds });
    const user = upsertTelegramUser(validated.user);
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    res.status(401).json({ error: 'Не удалось подтвердить Telegram-сессию. Открой приложение из Telegram ещё раз.' });
  }
});
router.post('/auth/dev', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  const user = createDemoUser(req.body.firstName || 'Demo');
  return res.json({ token: createToken(user.id), user: publicUser(user) });
});
router.delete('/dev/demo-user/:id', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  return res.json({ deleted: deleteDemoUser(Number(req.params.id)) });
});
router.get('/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));
router.get('/summary/today', authRequired, (req, res) => res.json(getSummary(req.user.id)));
router.post('/entries', authRequired, (req, res) => {
  try {
    const entry = createEntry(req.user.id, req.body.type, req.body.note || '');
    res.status(201).json({ entry, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.get('/entries', authRequired, (req, res) => {
  if (req.query.range === 'week') return res.json(getWeekSummary(req.user.id));
  return res.json({ entries: listEntries(req.user.id, req.query.range || 'today') });
});
router.get('/product', authRequired, (req, res) => res.json(getProductLayer(req.user.id, req.query.goal)));
router.get('/product/practices', authRequired, (req, res) => res.json(getPractices(req.query.goal)));
router.get('/contracts/current', authRequired, (req, res) => res.json({ contract: getCurrentContract(req.user.id) }));
router.post('/contracts', authRequired, (req, res) => {
  try { res.status(201).json({ contract: createContract(req.user.id, req.body) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/contracts/:id/close', authRequired, (req, res) => {
  try {
    const contract = closeContract(req.user.id, Number(req.params.id), req.body.status, req.body.resultNote || '');
    res.json({ contract, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/settings/reminders', authRequired, (req, res) => {
  const user = updateSettings(req.user.id, req.body);
  scheduleNextReminderForUser(req.user.id, { replace: true });
  res.json({ user: publicUser(user) });
});
module.exports = router;
