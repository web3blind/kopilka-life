const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { validateTelegramInitData } = require('../auth/validateTelegramInitData');
const { validateTelegramLogin } = require('../auth/validateTelegramLogin');
const { validateVkLaunchParams, parseLaunchParams } = require('../auth/validateVkLaunchParams');
const { createOAuthIntent, beginOAuthIntent, exchangeCode, consumeState, createOAuthLinkProof, consumeOAuthLinkProof, validBrowserBinding, buildOAuthWindowDocument, buildOAuthCallbackDocument, buildOAuthHandoffDocument, appOrigin } = require('../auth/vkOAuth');
const { createToken, verifyToken, inspectActiveToken } = require('../auth/session');
const { buildVkMergeOffer, buildMergePreview, applyMergeByToken } = require('../services/accountMergeService');
const { verifyMergeToken } = require('../auth/mergeToken');
const { publicUser, upsertTelegramUser, upsertVkUser, linkVkUser, createDemoUser, getUserById, updateLocale, updateSettings, updateVkMessagesAllowed, deleteDemoUser } = require('../services/usersService');
const { getVkFirstName } = require('../services/vkProfileService');
const { grantReferrerBonusOnFirstEntry, profileStats, publicProfileByCode } = require('../services/referralService');
const { listArtifacts, awardArtifactsForUser, artifactSummary } = require('../services/artifactsService');
const { createEntry, getSummary, getWeekSummary, listEntries, getHistory, updateEntryNote, deleteEntry } = require('../services/entriesService');
const { getCurrentContract, createContract, closeContract } = require('../services/contractsService');
const { scheduleNextReminderForUser, clearScheduledRemindersForUser } = require('../services/remindersService');
const pushService = require('../services/pushService');
const { getProductLayer, getPractices } = require('../services/productContentService');
const { listSupportActions, openSupportAction } = require('../services/supportActionsService');
const { maybeGrantRecoveryBonus } = require('../services/recoveryBonusService');
const { renderStoryCard, storyCardUrl, telegramProfileLink } = require('../services/storyCardService');
const daySceneStories = require('../services/daySceneStoryService');
const { vkMessagesConfigured } = require('../vkMessages');
const { createRateLimiter } = require('../middleware/rateLimit');
const { normalizeLocale, t } = require('../i18n');
const { countryFromIp, siteRegion } = require('../services/countryService');
const { requestEmailCode, verifyEmailCode } = require('../services/emailAuthService');
const { loginIdentityStatus, unlinkLoginIdentities } = require('../services/loginIdentityService');
const { createGoogleIntent, beginGoogleIntent, consumeGoogleState, assertGoogleLinkProof, exchangeGoogleCode, resolveGoogleUser } = require('../services/googleAuthService');
const { googleHandoff } = require('../auth/googleHandoff');
const { readOffer, confirmOffer, preview: identityMergePreview } = require('../services/identityMergeService');
const { getDb } = require('../db');
const { linkVerifiedTelegram, createLinkIntent, claimLinkIntent, finishLinkIntent } = require('../services/telegramLinkService');

const router = express.Router();
const storyLimiter = createRateLimiter({ windowMs: config.rateLimits.storyWindowMs, max: config.rateLimits.storyMax, keyPrefix: 'story' });
const authLimiter = createRateLimiter({ windowMs: config.rateLimits.authWindowMs, max: config.rateLimits.authMax, keyPrefix: 'auth', onLimit(req, res, retryAfter) {
  if (req.method === 'GET' && req.path === '/auth/vk-oauth/window') {
    const document = buildOAuthWindowDocument(retryAfter);
    oauthResponseHeaders(res, document.csp);
    return res.status(429).type('html').send(document.html);
  }
  return res.status(429).json({ error: 'Слишком много запросов. Попробуй чуть позже.' });
} });
const emailLimiter = createRateLimiter({ windowMs: 3600000, max: 30, keyPrefix: 'email-auth' });
const devLimiter = createRateLimiter({ windowMs: config.rateLimits.devWindowMs, max: config.rateLimits.devMax, keyPrefix: 'dev' });

// Translate an error message thrown as an i18n key (or pass through plain text).
function userError(locale, message) {
  if (typeof message === 'string' && message.startsWith('error.') && t(locale, message) !== message) {
    return t(locale, message);
  }
  return message;
}

function authRequired(req, res, next) {
  const inspected = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
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
function bearer(req) { return (req.get('authorization') || '').replace(/^Bearer\s+/i, ''); }
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
const GOOGLE_BROWSER_COOKIE = 'kopilka_google_browser';
function googleBrowser(req, res) {
  const current = readCookie(req, GOOGLE_BROWSER_COOKIE);
  if (/^[A-Za-z0-9_-]{32,128}$/.test(current)) return current;
  const value = crypto.randomBytes(32).toString('base64url');
  res.append('Set-Cookie', `${GOOGLE_BROWSER_COOKIE}=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${config.isProduction ? '; Secure' : ''}`);
  return value;
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

router.post('/auth/google/start', authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (siteRegion(countryFromIp(req.ip)) !== 'global') return res.status(403).json({ error: 'Этот способ входа недоступен для вашего IP.' });
  const linked = req.body.link === true;
  const session = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (linked && session.status !== 'valid') return res.status(401).json({ error: 'Сначала войди в свой аккаунт.' });
  try {
    return res.json(createGoogleIntent({ userId: linked ? session.userId : null, session: linked ? bearer(req) : '',
      refCode: req.body.refCode, timezone: req.body.timezone, locale: req.body.locale }));
  } catch (_) { return res.status(503).json({ error: 'Google-вход пока недоступен.' }); }
});
router.get('/auth/google/window', (req, res) => {
  oauthResponseHeaders(res);
  return res.type('html').send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Google — Копилка жизни</title><p role="status">Открываем Google…</p></html>');
});
router.get('/auth/google/authorize', authLimiter, (req, res) => {
  oauthResponseHeaders(res);
  if (siteRegion(countryFromIp(req.ip)) !== 'global') return res.status(403).send('Этот способ входа недоступен.');
  try { return res.redirect(303, beginGoogleIntent(req.query.intent, googleBrowser(req, res))); }
  catch (_) { return res.status(400).send('Ссылка входа устарела. Вернись в приложение и попробуй снова.'); }
});
router.get('/auth/google/callback', authLimiter, async (req, res) => {
  const secure = config.isProduction ? '; Secure' : '';
  const send = (payload) => {
    res.append('Set-Cookie', `${GOOGLE_BROWSER_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    const handoff = googleHandoff(payload);
    oauthResponseHeaders(res, handoff.csp);
    return res.type('html').send(handoff.html);
  };
  let channel = '';
  try {
    if (siteRegion(countryFromIp(req.ip)) !== 'global') throw new Error('Region restricted');
    const context = consumeGoogleState(req.query.state, readCookie(req, GOOGLE_BROWSER_COOKIE));
    channel = context.handoff_channel || '';
    assertGoogleLinkProof(context);
    if (req.query.error) throw new Error('Google access denied');
    const profile = await exchangeGoogleCode(req.query.code, context);
    const user = resolveGoogleUser(profile, context);
    if (user.mergeOffer) return send({ ...user.mergeOffer, channel });
    return send(context.user_id ? { linked: true, channel } : { token: createToken(user.id), channel });
  } catch (_) { return send({ channel, error: 'Не удалось подтвердить вход через Google. Попробуй ещё раз.' }); }
});
router.get('/settings/linked-logins', authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(loginIdentityStatus(req.user.id));
});
router.post('/settings/unlink-logins', authRequired, authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Подтверди отвязку e-mail и Google.' });
  try { return res.json(unlinkLoginIdentities(req.user.id)); }
  catch (error) { return res.status(409).json({ error: error.message }); }
});
router.post('/auth/email/request', emailLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const linked = req.body.link === true;
  const session = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (linked && session.status !== 'valid') return res.status(401).json({ error: 'Сначала войди в свой аккаунт.' });
  try {
    await requestEmailCode({ email: req.body.email, requestedBy: linked ? session.userId : null, session: linked ? bearer(req) : '' });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(error.message === 'Укажи корректный адрес электронной почты.' ? 400 : 503)
      .json({ error: error.message === 'Укажи корректный адрес электронной почты.' ? error.message : 'Письма пока недоступны. Попробуй позже.' });
  }
});
router.post('/auth/email/verify', emailLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const linked = req.body.link === true;
  const session = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (linked && session.status !== 'valid') return res.status(401).json({ error: 'Сначала войди в свой аккаунт.' });
  try {
    const user = verifyEmailCode({ email: req.body.email, code: req.body.code,
      requestedBy: linked ? session.userId : null, session: linked ? bearer(req) : '', refCode: req.body.refCode,
      timezone: req.body.timezone, locale: req.body.locale });
    if (!user) return res.status(401).json({ error: 'Неверный или просроченный код.' });
    if (user.mergeOffer) return res.status(409).json(user.mergeOffer);
    return res.json(linked ? { user: publicUser(user) } : { token: createToken(user.id), user: publicUser(user) });
  } catch (error) { return res.status(401).json({ error: 'Неверный или просроченный код либо адрес уже занят.' }); }
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
  if (siteRegion(countryFromIp(req.ip)) !== 'global') return res.status(403).json({ error: 'Этот способ входа недоступен для вашего IP.' });
  try {
    const validated = validateTelegramLogin(req.body, config.botToken, { maxAgeSeconds: config.telegramAuthMaxAgeSeconds });
    const user = upsertTelegramUser(validated.user, req.body.refCode, req.body.timezone);
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    res.status(401).json({ error: 'Не удалось подтвердить вход через Telegram.' });
  }
});
router.post('/auth/vk', authLimiter, async (req, res) => {
  try {
    const validated = validateVkLaunchParams(req.body.launchParams, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    const firstName = await getVkFirstName(validated.vkId);
    const user = upsertVkUser(validated.vkId, req.body.refCode, req.body.timezone, validated.language || req.body.locale || 'ru', firstName);
    res.json({ token: createToken(user.id), user: publicUser(user) });
  } catch (error) {
    console.error('[auth/vk] reject:', error && error.message ? error.message : String(error), vkLaunchDiag(req.body.launchParams));
    res.status(401).json({ error: 'Не удалось подтвердить VK-сессию. Открой приложение из VK ещё раз.' });
  }
});
// Both paths validate bot-signed Telegram data; a Telegram ID alone is never proof.
router.post('/settings/telegram-link-intent', authRequired, authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.botUsername || !config.botToken || /^\d+$/.test(String(req.user.telegram_id || '')))
    return res.status(400).json({ error: 'Привязка Telegram недоступна для этого аккаунта.' });
  const intent = createLinkIntent(req.user.id, bearer(req));
  return res.json({ intent, launchUrl: `https://t.me/${config.botUsername.replace(/^@/, '')}?startapp=link_${intent}` });
});
// No site bearer crosses into Telegram. Only bot-signed initData with its signed
// start_param can claim an intent; the initiating browser alone can finish it.
router.post('/auth/telegram-link-claim', authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const validated = validateTelegramInitData(req.body.initData, config.botToken, { maxAgeSeconds: 600 });
    const params = new URLSearchParams(req.body.initData);
    return res.json(claimLinkIntent(validated, params.get('start_param'), params.get('hash')));
  } catch (_) { return res.status(400).json({ error: 'Открой ссылку заново из своего аккаунта.' }); }
});
router.post('/settings/telegram-link-complete', authRequired, authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = finishLinkIntent(req.user.id, bearer(req), req.body.intent);
    return res.status(result.mergeRequired ? 409 : 200).json(result.pending || result.mergeRequired ? result : { user: publicUser(result.user) });
  } catch (_) { return res.status(400).json({ error: 'Ссылка устарела. Начни привязку заново.' }); }
});
router.post('/settings/link-telegram', authRequired, authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const widget = req.body.loginData;
    if (widget && siteRegion(countryFromIp(req.ip)) !== 'global') return res.status(403).json({ error: 'Этот способ входа недоступен для вашего IP.' });
    const validated = widget ? validateTelegramLogin(widget, config.botToken, { maxAgeSeconds: 600 }) :
      validateTelegramInitData(req.body.initData, config.botToken, { maxAgeSeconds: 600 });
    const proof = widget ? `widget:${validated.hash || widget.hash}` : `miniapp:${new URLSearchParams(req.body.initData).get('hash')}`;
    const result = linkVerifiedTelegram(req.user.id, validated, proof, bearer(req));
    return res.status(result.mergeRequired ? 409 : 200).json(result.mergeRequired ? result : { user: publicUser(result.user) });
  } catch (_) { return res.status(400).json({ error: 'Подтверди Telegram заново и попробуй ещё раз.' }); }
});
router.post('/settings/link-vk', authRequired, authLimiter, (req, res) => {
  try {
    const validated = validateVkLaunchParams(req.body.launchParams, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    const mergeOffer = buildVkMergeOffer(req.user.id, validated.vkId, bearer(req));
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
    if (!config.vkOAuthClientId) return res.status(503).json({ error: 'Вход через VK ID пока не настроен.' });
    const action = req.body.action === 'link' ? 'link' : 'auth';
    let userId = null;
    if (action === 'link') {
      userId = verifyToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      if (!userId) return res.status(401).json({ error: 'Сначала войдите в аккаунт, к которому нужно привязать VK.' });
    }
    const created = createOAuthIntent({ channel: req.body.channel, action, userId, refCode: req.body.refCode || '', timezone: req.body.timezone || '', locale: req.body.locale || req.locale || 'ru' });
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
  const document = buildOAuthWindowDocument();
  oauthResponseHeaders(res, document.csp);
  res.type('html').send(document.html);
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
// GET is a read-only landing document: speculative navigation must never spend state.
router.get('/auth/vk-oauth/callback', (req, res) => {
  const document = buildOAuthCallbackDocument();
  oauthResponseHeaders(res, document.csp);
  return res.type('html').send(document.html);
});
router.post('/auth/vk-oauth/complete', authLimiter, async (req, res) => {
  oauthResponseHeaders(res);
  if (req.get('origin') !== appOrigin()) return res.status(403).json({ error: 'Same-origin completion required' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON completion required' });
  const input = req.body || {};
  const send = payload => {
    expireOAuthBrowser(res);
    return res.json({ type: 'kopilka:vk-oauth', ...payload });
  };
  let stateContext = null;
  try {
    stateContext = consumeState(String(input.state || ''), currentOAuthBrowser(req));
    if (input.error) throw new Error('VK OAuth access denied');
    const tokens = await exchangeCode({ code: String(input.code || ''), deviceId: String(input.device_id || ''), state: String(input.state || ''), codeVerifier: stateContext.codeVerifier });
    const vkId = String(tokens.user_id);
    if (stateContext.action === 'link') {
      if (!stateContext.userId) throw new Error('VK OAuth link target is missing');
      const linkProof = createOAuthLinkProof({ targetUserId: Number(stateContext.userId), vkId, channel: stateContext.channel });
      return send({ channel: stateContext.channel, action: 'link', linkProof });
    }
    const firstName = await getVkFirstName(vkId);
    const user = upsertVkUser(vkId, stateContext.refCode || '', stateContext.timezone || '', stateContext.locale || 'ru', firstName);
    const appToken = createToken(user.id);
    return send({ channel: stateContext.channel, action: 'auth', token: appToken });
  } catch (error) {
    // Provider errors may contain credentials: never log or reflect their text.
    if (!stateContext) return res.status(400).json({ error: 'Не удалось завершить вход через VK ID.' });
    return send({ channel: stateContext.channel, action: stateContext.action, error: 'Не удалось завершить вход через VK ID.' });
  }
});
router.post('/auth/vk-oauth/finalize-link', authRequired, authLimiter, (req, res) => {
  try {
    const verified = consumeOAuthLinkProof(String(req.body.proof || ''), req.user.id);
    const mergeOffer = buildVkMergeOffer(req.user.id, verified.vkId, bearer(req));
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
router.post('/account/merge-identity/preview', authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const offer = readOffer(req.body.mergeToken, bearer(req), req.user.id);
    return res.json({ mergeToken: req.body.mergeToken, preview: identityMergePreview(getDb(), offer.current_user_id, offer.other_user_id) });
  } catch (_) { return res.status(403).json({ error: 'Подтверди привязку заново в этом аккаунте.' }); }
});
router.post('/account/merge-identity/confirm', authRequired, authLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Подтверди объединение аккаунтов.' });
  try {
    const result = confirmOffer(req.body.mergeToken, bearer(req), req.user.id);
    return res.json({ token: createToken(result.user.id), user: publicUser(result.user), preview: result.preview,
      summary: getSummary(result.user.id), week: getWeekSummary(result.user.id) });
  } catch (error) {
    if (error.preview) return res.status(409).json({ error: 'Есть несовместимые данные. Аккаунты не изменены; обратись в поддержку.', preview: error.preview });
    return res.status(400).json({ error: 'Подтверди привязку заново в этом аккаунте.' });
  }
});
router.post('/account/merge-vk/preview', authRequired, (req, res) => {
  try {
    const data = verifyMergeToken(req.body.mergeToken || '');
    if (data.authenticatedUserId !== req.user.id) return res.status(403).json({ error: 'Нельзя объединить аккаунты из другой сессии.' });
    if (data.sessionHash && crypto.createHash('sha256').update(bearer(req)).digest('hex') !== data.sessionHash) return res.status(403).json({ error: 'Повтори подтверждение VK в этой сессии.' });
    res.json({ preview: buildMergePreview(data.primaryUserId, data.sourceUserId, { transferLogins: data.authenticatedUserId === data.sourceUserId }), mergeToken: req.body.mergeToken });
  } catch (error) {
    res.status(400).json({ error: 'Не удалось подготовить слияние аккаунтов.' });
  }
});
router.post('/account/merge-vk/confirm', authRequired, (req, res) => {
  try {
    const result = applyMergeByToken(req.body.mergeToken || '', req.user.id, bearer(req));
    res.json({ token: createToken(result.user.id), user: publicUser(result.user), preview: result.preview, summary: getSummary(result.user.id), week: getWeekSummary(result.user.id) });
  } catch (error) {
    console.error('[account/merge-vk/confirm] reject:', error && error.message ? error.message : String(error));
    if (error.preview) {
      const reasons = error.preview.blocking.map((reason) => t(req.locale, `error.merge.${reason}`));
      return res.status(409).json({ error: reasons.join(' '), preview: error.preview });
    }
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
    telegramProfileLink: botLink ? telegramProfileLink(stats.refCode) : null,
    telegramStoryCardUrl: storyCardUrl(stats.refCode, 'telegram', req.locale),
    vkStoryCardUrl: storyCardUrl(stats.refCode, 'vk', req.locale),
    vkRefLink: vkAppBase ? `${vkAppBase}#ref=${stats.refCode}` : null,
    vkProfileLink: vkAppBase ? `${vkAppBase}#profile=${stats.refCode}` : null
  } });
});
router.post('/day-scene-story', authRequired, storyLimiter,
  (req, res, next) => req.is('image/png') ? next() : res.status(415).json({ error: 'PNG required' }),
  express.raw({ type: 'image/png', limit: '4mb' }), async (req, res, next) => {
    try {
      const base = new URL(config.webappUrl);
      if (config.isProduction && base.protocol !== 'https:') throw new Error('HTTPS story media required');
      const id = await daySceneStories.create(req.user.id, req.body);
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({ url: new URL(`/api/day-scene-story/${id}.png`, base).href });
    } catch (error) {
      if (error.message === 'invalid_image') return res.status(400).json({ error: 'Invalid picture' });
      if (error.message === 'story_capacity') return res.status(503).json({ error: 'Story pictures are temporarily busy' });
      return next(error);
    }
  });
router.get('/day-scene-story/:id.png', storyLimiter, (req, res) => {
  const png = daySceneStories.get(req.params.id);
  if (!png) return res.status(404).json({ error: 'not found' });
  res.set({
    'Content-Type': 'image/png', 'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, noarchive',
    'Referrer-Policy': 'no-referrer'
  });
  return res.send(png);
});
router.get('/story-card/:code.png', storyLimiter, async (req, res, next) => {
  try {
    const platform = String(req.query.platform || '');
    const result = await renderStoryCard(req.params.code, platform, req.query.locale);
    if (result.error === 'invalid_code') return res.status(400).json({ error: 'invalid code' });
    if (result.error === 'invalid_platform') return res.status(400).json({ error: 'invalid platform' });
    if (result.error === 'not_found') return res.status(404).json({ error: 'not found' });
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.send(result.png);
  } catch (error) {
    return next(error);
  }
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
    const contract = closeContract(req.user.id, Number(req.params.id), req.body.status, req.body.resultNote);
    const awardedArtifacts = awardArtifactsForUser(req.user.id, null);
    res.json({ contract, summary: getSummary(req.user.id), week: getWeekSummary(req.user.id), awardedArtifacts });
  } catch (error) { res.status(400).json({ error: userError(req.locale, error.message) }); }
});
const pushLimiter = createRateLimiter({ windowMs: 60000, max: 15, keyPrefix: 'push-settings' });
router.get('/settings/push', authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ available: pushService.configured(), publicKey: pushService.configured() ? config.vapidPublicKey : '',
    subscriptionCount: pushService.listSubscriptions(req.user.id).length });
});
router.post('/settings/push/status', pushLimiter, authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const endpoint = req.body?.endpoint;
  const subscribed = typeof endpoint === 'string' && endpoint.length <= 2048 &&
    pushService.listSubscriptions(req.user.id).some(row => row.endpoint_hash === pushService.endpointHash(endpoint));
  res.json({ subscribed: Boolean(subscribed) });
});
router.post('/settings/push', pushLimiter, authRequired, (req, res) => {
  try {
    const result = pushService.subscribe(req.user.id, req.body);
    scheduleNextReminderForUser(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(result);
  } catch (_) { res.status(400).json({ error: 'Unable to enable browser notifications' }); }
});
router.delete('/settings/push', pushLimiter, authRequired, (req, res) => {
  try {
    const result = pushService.unsubscribe(req.user.id, req.body?.endpoint);
    scheduleNextReminderForUser(req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (_) { res.status(400).json({ error: 'Unable to disable browser notifications' }); }
});
// Older WebViews lack Intl.supportedValuesOf; use the server's IANA catalog.
router.get('/settings/timezones', authRequired, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ timezones: Intl.supportedValuesOf('timeZone') });
});
router.post('/settings/reminders', authRequired, (req, res) => {
  let user;
  try { user = updateSettings(req.user.id, req.body); }
  catch (error) {
    if (error.message === 'error.invalidTimezone') return res.status(400).json({ error: t(req.user.locale, 'error.invalidTimezone') });
    throw error;
  }
  if (!user.reminders_enabled) clearScheduledRemindersForUser(req.user.id);
  else scheduleNextReminderForUser(req.user.id, { replace: true });
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
