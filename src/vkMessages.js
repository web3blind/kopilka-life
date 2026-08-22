const crypto = require('crypto');
const config = require('./config');
const { normalizeLocale, t } = require('./i18n');

function vkAppUrl() {
  if (config.vkAppId) return `https://vk.com/app${config.vkAppId}`;
  return config.webappUrl;
}

function reminderText(locale) {
  const lang = normalizeLocale(locale);
  const message = t(lang, 'vk.reminder');
  const url = vkAppUrl();
  return url ? `${message}\n\n${url}` : message;
}
function reminderKeyboard(locale) {
  const url = vkAppUrl();
  if (!url) return undefined;
  const lang = normalizeLocale(locale);
  return JSON.stringify({
    inline: true,
    buttons: [[{
      action: { type: 'open_link', label: t(lang, 'bot.open'), link: url }
    }]]
  });
}

async function callVk(method, payload) {
  if (!config.vkGroupToken || config.vkGroupToken === 'replace_me' || config.vkGroupToken.startsWith('test-') || config.nodeEnv === 'test') {
    console.log(`[vk:dry] ${method}`, JSON.stringify({ ...payload, access_token: '[REDACTED]' }));
    return { response: 1, dryRun: true };
  }
  const body = new URLSearchParams({ ...payload, access_token: config.vkGroupToken, v: '5.199' });
  const res = await fetch(`https://api.vk.com/method/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const code = data.error?.error_code || res.status;
    const msg = data.error?.error_msg || `HTTP ${res.status}`;
    console.error(`VK API error ${method}:`, code, msg);
    const error = new Error(`VK API error: ${code}`);
    error.code = code;
    error.vkMessage = msg;
    throw error;
  }
  return data;
}

async function sendVkReminder(vkUserId, locale) {
  if (!vkUserId) throw new Error('VK user id is missing');
  const basePayload = {
    user_id: String(vkUserId),
    random_id: crypto.randomInt(1, 2147483647),
    message: reminderText(locale),
    dont_parse_links: 0
  };
  try {
    return await callVk('messages.send', { ...basePayload, keyboard: reminderKeyboard(locale) });
  } catch (error) {
    if (![911, 912].includes(Number(error.code))) throw error;
    console.error('VK keyboard rejected; retrying reminder without keyboard');
    return callVk('messages.send', { ...basePayload, random_id: crypto.randomInt(1, 2147483647) });
  }
}

module.exports = { callVk, sendVkReminder, reminderText, reminderKeyboard, vkAppUrl };
