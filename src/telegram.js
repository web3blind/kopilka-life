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
module.exports = { callTelegram, sendStart, sendReminder };
