const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { validateTelegramInitData } = require('../auth/validateTelegramInitData');
const { validateTelegramLogin } = require('../auth/validateTelegramLogin');
const { validateVkLaunchParams, parseLaunchParams } = require('../auth/validateVkLaunchParams');
const { createOAuthIntent, beginOAuthIntent, exchangeCode, consumeState, createOAuthLinkProof, consumeOAuthLinkProof, validBrowserBinding, buildOAuthHandoffDocument, appOrigin } = require('../auth/vkOAuth');
const { createToken, verifyToken, inspectToken } = require('../auth/session');
const { buildVkMergeOffer, buildMergePreview, applyMergeByToken } = require('../services/accountMergeService');
const { verifyMergeToken } = require('../auth/mergeToken');
const { publicUser, upsertTelegramUser, upsertVkUser, linkVkUser, createDemoUser, getUserById, updateLocale, updateSettings, updateVkMessagesAllowed, deleteDemoUser } = require('../services/usersService');
const { grantReferrerBonusOnFirstEntry, profileStats, publicProfileByCode } = require('../services/referralService');
const { listArtifacts, awardArtifactsForUser, artifactSummary } = require('../services/artifactsService');
const { createEntry, getSummary, getWeekSummary, listEntries, getHistory, updateEntryNote, deleteEntry } = require('../services/entriesService');
const { getCurrentContract, createContract, closeContract } = require('../services/contractsService');
const { scheduleNextReminderForUser } = require('../services/remindersService');
const { getProductLayer, getPractices } = require('../services/productContentService');
const { listSupportActions, openSupportAction } = require('../services/supportActionsService');
const { maybeGrantRecoveryBonus } = require('../services/recoveryBonusService');
const { vkMessagesConfigured } = require('../vkMessages');
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
  const inspected = inspectToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (inspected.status !== 'valid') {
    const surface = String(req.get('x-kopilka-surface') || '').toLowerCase();
    const key = surface === 'vk' ? 'error.vkSession' : (surface === 'telegram' ? 'error.telegramSession' : 'error.session');
    return res.status(401).json({ error: t(req.locale || 'ru', key), code: inspected.status === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_INVALID' });
  }
  const userId = inspected.userId;
  const user = getUserById(userId);
  if (!user) return res.status(401).json({ error: t(req.locale || 'ru', 'error.userNotFound'), code: 'SESSION_INVALID' });
  req.user = user;
  req.locale = normalizeLocale(user.locale);
  return next();
}
function disabled(res) { return res.status(404).json({ error: 'disabled' }); }
function compactClientLog(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/(sign=)[^&\s]+/g, '$1[REDACTED]').replace(/(token=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 240);
}
function vkLaunchDiag(input) {
  try {
    const params = parseLaunchParams(input || '');
    const ts = Number(params.get('vk_ts') || 0);
    const age = ts ? Math.floor(Date.now() / 1000) - ts : null;
    return JSON.stringify({
      len: String(input || '').length,
      appId: params.get('vk_app_id') || '',
      hasSign: Boolean(params.get('sign')),
      signLen: String(params.get('sign') || '').length,
      hasUser: Boolean(params.get('vk_user_id')),
      tsAgeSeconds: age
    });
  } catch (error) {
    return JSON.stringify({ len: String(input || '').length, parseError: error && error.message ? error.message : String(error) });
  }
}

const OAUTH_BROWSER_COOKIE = 'kopilka_oauth_browser';
function readCookie(req, name) {
  for (const value of String(req.get('cookie') || '').split(';')) {
    const [key, ...rest] = value.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function currentOAuthBrowser(req) {
  const value = readCookie(req, OAUTH_BROWSER_COOKIE);
  return validBrowserBinding(value) ? value : '';
}
function ensureOAuthBrowser(req, res) {
  const existing = currentOAuthBrowser(req);
  if (existing) return existing;
  const value = crypto.randomBytes(32).toString('base64url');
  const secure = config.isProduction ? '; Secure' : '';
  const maxAge = Math.max(60, Number(config.vkOAuthStateMaxAgeSeconds) || 600);
  res.append('Set-Cookie', `${OAUTH_BROWSER_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/vk-oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  return value;
}

function expireOAuthBrowser(res) {
  const secure = config.isProduction ? '; Secure' : '';
  res.append('Set-Cookie', `${OAUTH_BROWSER_COOKIE}=; Path=/api/auth/vk-oauth; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function oauthResponseHeaders(res, csp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'") {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
}

function sendOAuthHandoff(res, payload, { expireBinding = true } = {}) {
  const document = buildOAuthHandoffDocument(payload, appOrigin());
  oauthResponseHeaders(res, document.csp);
  if (expireBinding) expireOAuthBrowser(res);
  return res.type('html').send(document.html);
}

router.post('/client-log', (req, res) => {
  const event = compactClientLog(req.body.event);
  const details = compactClientLog(req.body.details);
  const platform = compactClientLog(req.body.platform);
  const version = compactClientLog(req.body.version);
  if (event) console.log(`[client-log] ${event} platform=${platform} version=${version} details=${details}`);
  res.json({ ok: true });
});

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
    console.error('[auth/vk] reject:', error && error.message ? error.message : String(error), vkLaunchDiag(req.body.launchParams));
    res.status(401).json({ error: 'Не удалось подтвердить VK-сессию. Открой приложение из VK ещё раз.' });
  }
});
router.post('/settings/link-vk', authRequired, authLimiter, (req, res) => {
  try {
    const validated = validateVkLaunchParams(req.body.launchParams, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    const mergeOffer = buildVkMergeOffer(req.user.id, validated.vkId);
    if (mergeOffer) return res.status(409).json(mergeOffer);
    const user = linkVkUser(req.user.id, validated.vkId);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('[settings/link-vk] reject:', error && error.message ? error.message : String(error));
    res.status(400).json({ error: error.message || 'Не удалось привязать VK.' });
  }
});
router.post('/auth/vk-oauth/intent', authLimiter, (req, res) => {
  try {
    const action = req.body.action === 'link' ? 'link' : 'auth';
    let userId = null;
    if (action === 'link') {
      userId = verifyToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      if (!userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт, к которому нужно привязать VK.' });
    }
    const created = createOAuthIntent({ action, userId, refCode: req.body.refCode || '', timezone: req.body.timezone || '', locale: req.body.locale || req.locale || 'ru' });
    const launchUrl = new URL('/api/auth/vk-oauth/start', appOrigin());
    launchUrl.searchParams.set('intent', created.intent);
    res.json({ launchUrl: launchUrl.toString(), channel: created.channel });
  } catch (error) {
    console.error('[auth/vk-oauth/intent] reject:', error && error.message ? error.message : String(error));
    res.status(400).json({ error: 'Не удалось начать вход через VK ID.' });
  }
});
router.get('/auth/vk-oauth/window', authLimiter, (req, res) => {
  ensureOAuthBrowser(req, res);
  oauthResponseHeaders(res);
  res.type('html').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VK ID — Копилка жизни</title></head><body><main><h1>Открываем VK ID</h1><p role="status">Подготавливаем безопасный вход…</p></main></body></html>');
});
router.get('/auth/vk-oauth/start', authLimiter, (req, res) => {
  try {
    const browserBinding = ensureOAuthBrowser(req, res);
    const authUrl = beginOAuthIntent(String(req.query.intent || ''), browserBinding);
    oauthResponseHeaders(res);
    res.redirect(303, authUrl);
  } catch (error) {
    console.error('[auth/vk-oauth/start] reject:', error && error.message ? error.message : String(error));
    oauthResponseHeaders(res);
    res.status(400).type('html').send('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>VK ID — Копилка жизни</title></head><body><main><h1>Не удалось начать вход</h1><p>Вернитесь в Копилку жизни и попробуйте снова.</p><p><a href="/">Вернуться в приложение</a></p></main></body></html>');
  }
});
router.get('/auth/vk-oauth/callback', authLimiter, async (req, res) => {
  let stateContext = null;
  try {
    stateContext = consumeState(String(req.query.state || ''), currentOAuthBrowser(req));
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const tokens = await exchangeCode({ code: String(req.query.code || ''), deviceId: String(req.query.device_id || ''), state: String(req.query.state || ''), codeVerifier: stateContext.codeVerifier });
    const vkId = String(tokens.user_id);
    if (stateContext.action === 'link') {
      if (!stateContext.userId) throw new Error('VK OAuth link target is missing');
      const linkProof = createOAuthLinkProof({ targetUserId: Number(stateContext.userId), vkId, channel: stateContext.channel });
      return sendOAuthHandoff(res, { type: 'kopilka:vk-oauth', channel: stateContext.channel, action: 'link', linkProof });
    }
    const user = upsertVkUser(vkId, stateContext.refCode || '', stateContext.timezone || '', stateContext.locale || 'ru');
    const appToken = createToken(user.id);
    return sendOAuthHandoff(res, { type: 'kopilka:vk-oauth', channel: stateContext.channel, action: 'auth', token: appToken });
  } catch (error) {
    console.error('[auth/vk-oauth/callback] reject:', error && error.message ? error.message : String(error));
    return sendOAuthHandoff(res, { type: 'kopilka:vk-oauth', channel: stateContext?.channel || '', action: stateContext?.action || 'auth', error: 'Не удалось завершить вход через VK ID.' }, { expireBinding: Boolean(stateContext) });
  }
});
router.post('/auth/vk-oauth/finalize-link', authRequired, authLimiter, (req, res) => {
  try {
    const verified = consumeOAuthLinkProof(String(req.body.proof || ''), req.user.id);
    const mergeOffer = buildVkMergeOffer(req.user.id, verified.vkId);
    if (mergeOffer) return res.status(409).json(mergeOffer);
    const user = linkVkUser(req.user.id, verified.vkId);
    return res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    console.error('[auth/vk-oauth/finalize-link] reject:', error && error.message ? error.message : String(error));
    if (/target session does not match/i.test(error.message || '')) return res.status(403).json({ error: 'Эта VK-сессия предназначена для другого аккаунта.' });
    return res.status(400).json({ error: 'Не удалось безопасно завершить привязку VK.' });
  }
});
// Public, non-sensitive config the site needs to render sign-in options.
router.get('/config', (req, res) => res.json({ botUsername: config.botUsername, webappUrl: config.webappUrl, telegramLoginWidgetEnabled: config.telegramLoginWidgetEnabled, vkAppId: config.vkAppId, vkGroupId: config.vkGroupId, vkOAuthEnabled: Boolean(config.vkOAuthClientId), vkMessagesEnabled: vkMessagesConfigured() }));
router.post('/auth/dev', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  const user = createDemoUser(req.body.firstName || 'Demo', req.body.locale, req.body.refCode, req.body.timezone);
  return res.json({ token: createToken(user.id), user: publicUser(user) });
});
router.delete('/dev/demo-user/:id', devLimiter, (req, res) => {
  if (!config.devAuthEnabled) return disabled(res);
  return res.json({ deleted: deleteDemoUser(Number(req.params.id)) });
});
router.get('/me', authRequired, (req, res) => {
  const recoveryNotice = maybeGrantRecoveryBonus(req.user.id, req.user.locale || req.locale || 'ru');
  res.json({ user: publicUser(req.user), recoveryNotice });
});
router.post('/account/merge-vk/preview', authRequired, (req, res) => {
  try {
    const data = verifyMergeToken(req.body.mergeToken || '');
    if (data.primaryUserId !== req.user.id) return res.status(403).json({ error: 'Нельзя объединить аккаунты из другой сессии.' });
    res.json({ preview: buildMergePreview(data.primaryUserId, data.sourceUserId), mergeToken: req.body.mergeToken });
  } catch (error) {
    res.status(400).json({ error: 'Не удалось подготовить слияние аккаунтов.' });
  }
});
router.post('/account/merge-vk/confirm', authRequired, (req, res) => {
  try {
    const result = applyMergeByToken(req.body.mergeToken || '', req.user.id);
    res.json({ user: publicUser(result.user), preview: result.preview, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) {
    console.error('[account/merge-vk/confirm] reject:', error && error.message ? error.message : String(error));
    if (error.preview) return res.status(409).json({ error: 'Слияние пока нельзя выполнить: есть конфликт активных договоров.', preview: error.preview });
    res.status(400).json({ error: 'Не удалось объединить аккаунты.' });
  }
});
router.get('/profile', authRequired, (req, res) => {
  const stats = profileStats(req.user.id);
  const botLink = config.botUsername ? `https://t.me/${config.botUsername.replace(/^@/, '')}?startapp=${stats.refCode}` : null;
  const vkAppBase = config.vkAppId ? `https://vk.com/app${config.vkAppId}` : null;
  res.json({ profile: {
    ...publicUser(req.user),
    ...stats,
    artifacts: artifactSummary(req.user.id),
    refLink: `${config.webappUrl}?ref=${stats.refCode}`,
    profileLink: `${config.webappUrl}/p/${stats.refCode}`,
    botLink,
    vkRefLink: vkAppBase ? `${vkAppBase}#ref=${stats.refCode}` : null,
    vkProfileLink: vkAppBase ? `${vkAppBase}#profile=${stats.refCode}` : null
  } });
});
router.get('/public/:code', (req, res) => {
  const profile = publicProfileByCode(req.params.code);
  if (!profile) return res.status(404).json({ error: 'not found' });
  res.json({ profile });
});
router.get('/artifacts', authRequired, (req, res) => res.json({ artifacts: listArtifacts(req.user.id) }));
router.get('/support/actions', authRequired, (req, res) => res.json(listSupportActions(req.user.id, req.query.source || 'web', req.locale)));
router.post('/support/actions/:id/open', authRequired, (req, res) => {
  try {
    res.json(openSupportAction(req.user.id, Number(req.params.id), req.body.source || 'app', req.locale));
  } catch (error) {
    res.status(404).json({ error: 'Не удалось открыть это действие поддержки.' });
  }
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
    const awardedArtifacts = awardArtifactsForUser(req.user.id, entry.id);
    res.status(201).json({ entry, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id), awardedArtifacts });
  } catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
router.get('/entries', authRequired, (req, res) => {
  if (req.query.range === 'week') return res.json(getWeekSummary(req.user.id));
  return res.json({ entries: listEntries(req.user.id, req.query.range || 'today') });
});
router.get('/history', authRequired, (req, res) => {
  try {
    res.json(getHistory(req.user.id, { date: req.query.date, days: req.query.days === undefined ? 7 : Number(req.query.days) }));
  } catch (error) {
    res.status(400).json({ error: userError(req.locale, error.message) });
  }
});
router.patch('/entries/:id', authRequired, (req, res) => {
  try {
    const entry = updateEntryNote(req.user.id, req.params.id, req.body.note || '');
    res.json({ entry, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id) });
  } catch (error) {
    res.status(error.status || 400).json({ error: userError(req.locale, error.message) });
  }
});
router.delete('/entries/:id', authRequired, (req, res) => {
  if (req.body.confirm !== true) return res.status(400).json({ error: t(req.locale, 'error.entryDeleteConfirm') });
  try {
    const entry = deleteEntry(req.user.id, req.params.id);
    res.json({ deleted: true, entryId: entry.id, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id), artifactsRetained: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: userError(req.locale, error.message) });
  }
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
    const awardedArtifacts = awardArtifactsForUser(req.user.id, null);
    res.json({ contract, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id), awardedArtifacts });
  } catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
router.post('/settings/reminders', authRequired, (req, res) => {
  const user = updateSettings(req.user.id, req.body);
  scheduleNextReminderForUser(req.user.id, { replace: true });
  res.json({ user: publicUser(user) });
});
router.post('/settings/vk-messages', authRequired, (req, res) => {
  if (!req.user.vk_id) return res.status(400).json({ error: 'VK не привязан к этому аккаунту.' });
  const allowed = Boolean(req.body.allowed);
  let user = updateVkMessagesAllowed(req.user.id, allowed);
  if (allowed && req.body.enableReminders !== false) {
    user = updateSettings(req.user.id, { remindersEnabled: true, eveningReminderTime: user.evening_reminder_time, timezone: user.timezone });
  }
  scheduleNextReminderForUser(req.user.id, { replace: true });
  res.json({ user: publicUser(getUserById(req.user.id)) });
});
module.exports = router;
