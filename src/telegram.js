const crypto = require('crypto');
const config = require('./config');
const { normalizeLocale, t } = require('./i18n');
const TELEGRAM_OUTBOUND_TIMEOUT_MS = 15 * 1000;
async function callTelegram(method, payload) {
  if (!config.botToken || config.botToken === 'replace_me' || config.nodeEnv === 'test') { console.log(`[telegram:dry] ${method}`, JSON.stringify(payload)); return { ok: true, dryRun: true }; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_OUTBOUND_TIMEOUT_MS);
  let res;
  let data;
  try {
    res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    data = await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok || !data.ok) { console.error(`Telegram API error ${method}:`, res.status, JSON.stringify(data)); throw new Error(`Telegram API error: ${res.status}`); }
  return data;
}
function miniAppKeyboard(locale) { return { inline_keyboard: [[{ text: t(locale, 'bot.open'), web_app: { url: config.webappUrl } }]] }; }
async function sendStart(chatId, locale) { const lang = normalizeLocale(locale); return callTelegram('sendMessage', { chat_id: chatId, text: t(lang, 'bot.start'), reply_markup: miniAppKeyboard(lang) }); }
async function sendReminder(chatId, locale, extraText = '') {
  const lang = normalizeLocale(locale);
  const text = [t(lang, 'bot.reminder'), String(extraText || '').trim()].filter(Boolean).join('\n\n');
  return callTelegram('sendMessage', { chat_id: chatId, text, reply_markup: miniAppKeyboard(lang) });
}
// Inline mode: return the shared message as a single article so the user can
// forward it (text + link) into any chat after switchInlineQuery picks one.
function canonicalAppUrl() {
  try {
    const url = new URL(config.webappUrl);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch (_) {
    return null;
  }
}
function isTrustedInlineDestination(url, appUrl) {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (appUrl && url.origin === appUrl.origin) {
    const basePath = appUrl.pathname.replace(/\/$/, '');
    const relativePath = url.pathname.slice(basePath.length) || '/';
    const staysUnderBase = !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    return staysUnderBase && (relativePath === '/' || /^\/p\/[A-Za-z0-9]{4,24}\/?$/.test(relativePath));
  }
  const botUsername = String(config.botUsername || '').replace(/^@/, '').trim();
  if (botUsername && url.hostname === 't.me' && url.port === '' && url.pathname.toLowerCase() === `/${botUsername.toLowerCase()}`) {
    return !url.hash && Array.from(url.searchParams.keys()).every((key) => key === 'start' || key === 'startapp');
  }
  return Boolean(config.vkAppId) && url.hostname === 'vk.com' && url.port === '' && url.pathname === `/app${config.vkAppId}`;
}
function httpsDestination(text) {
  const appUrl = canonicalAppUrl();
  const candidates = String(text || '').match(/https:\/\/[^\s]+/g) || [];
  for (const candidate of candidates.reverse()) {
    try {
      const url = new URL(candidate.replace(/[),.!?\]}]+$/, ''));
      if (isTrustedInlineDestination(url, appUrl)) return url.toString();
    } catch (_) { /* inspect the next candidate */ }
  }
  return appUrl ? appUrl.toString() : '';
}
function buildInlineQueryResults(text, locale = 'ru') {
  const lang = normalizeLocale(locale);
  const destination = httpsDestination(text);
  return [{
    type: 'article',
    id: cryptoHash(text).slice(0, 32),
    title: t(lang, 'inline.shareTitle'),
    description: text.slice(0, 120),
    input_message_content: { message_text: text, disable_web_page_preview: false },
    ...(destination ? { reply_markup: { inline_keyboard: [[{ text: t(lang, 'bot.open'), url: destination }]] } } : {})
  }];
}
function cryptoHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
async function answerInlineQuery(inlineQueryId, text, locale = 'ru') {
  const results = buildInlineQueryResults(text, locale);
  return callTelegram('answerInlineQuery', { inline_query_id: inlineQueryId, results, cache_time: 0, is_personal: true });
}
module.exports = { callTelegram, sendStart, sendReminder, answerInlineQuery, buildInlineQueryResults, TELEGRAM_OUTBOUND_TIMEOUT_MS };
