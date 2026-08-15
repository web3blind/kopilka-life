const config = require('./config');
async function callTelegram(method, payload) {
  if (!config.botToken || config.botToken === 'replace_me' || config.nodeEnv === 'test') { console.log(`[telegram:dry] ${method}`, JSON.stringify(payload)); return { ok: true, dryRun: true }; }
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) { console.error(`Telegram API error ${method}:`, res.status, JSON.stringify(data)); throw new Error(`Telegram API error: ${res.status}`); }
  return data;
}
function miniAppKeyboard() { return { inline_keyboard: [[{ text: 'Открыть Копилку жизни', web_app: { url: config.webappUrl } }]] }; }
async function sendStart(chatId) { return callTelegram('sendMessage', { chat_id: chatId, text: 'Это Копилка жизни. Здесь можно за 10 секунд отметить маленькие вещи, которые поддержали день.', reply_markup: miniAppKeyboard() }); }
async function sendReminder(chatId) { return callTelegram('sendMessage', { chat_id: chatId, text: 'Если есть силы, можно за 10 секунд пополнить Копилку жизни.', reply_markup: miniAppKeyboard() }); }
module.exports = { callTelegram, sendStart, sendReminder };
