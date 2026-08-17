const config = require('./config');
const { normalizeLocale, t } = require('./i18n');
async function callTelegram(method, payload) {
  if (!config.botToken || config.botToken === 'replace_me' || config.nodeEnv === 'test') { console.log(`[telegram:dry] ${method}`, JSON.stringify(payload)); return { ok: true, dryRun: true }; }
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { console.error(`Telegram API error ${method}:`, res.status, JSON.stringify(data)); throw new Error(`Telegram API error: ${res.status}`); }
  return data;
}
function miniAppKeyboard(locale) { return { inline_keyboard: [[{ text: t(locale, 'bot.open'), web_app: { url: config.webappUrl } }]] }; }
async function sendStart(chatId, locale) { const lang = normalizeLocale(locale); return callTelegram('sendMessage', { chat_id: chatId, text: t(lang, 'bot.start'), reply_markup: miniAppKeyboard(lang) }); }
async function sendReminder(chatId, locale) { const lang = normalizeLocale(locale); return callTelegram('sendMessage', { chat_id: chatId, text: t(lang, 'bot.reminder'), reply_markup: miniAppKeyboard(lang) }); }
// Inline mode: return the shared message as a single article so the user can
// forward it (text + link) into any chat after switchInlineQuery picks one.
async function answerInlineQuery(inlineQueryId, text, locale = 'ru') {
  const lang = normalizeLocale(locale);
  const results = [{
    type: 'article',
    id: 'share-' + Date.now(),
    title: t(lang, 'inline.shareTitle'),
    description: text.slice(0, 120),
    input_message_content: { message_text: text, disable_web_page_preview: false },
    reply_markup: { inline_keyboard: [[{ text: t(lang, 'bot.open'), web_app: { url: config.webappUrl } }]] }
  }];
  return callTelegram('answerInlineQuery', { inline_query_id: inlineQueryId, results, cache_time: 0, is_personal: true });
}
module.exports = { callTelegram, sendStart, sendReminder, answerInlineQuery };
