const crypto = require('crypto');
const config = require('./config');
const { normalizeLocale, t } = require('./i18n');

let tokenOwnerCheck = { checkedAt: 0, ok: null, ownerGroupId: '', reason: '' };

function vkAppUrl() {
  if (config.vkAppId) return `https://vk.com/app${config.vkAppId}`;
  return config.webappUrl;
}

function reminderText(locale, extraText = '') {
  const lang = normalizeLocale(locale);
  const message = [t(lang, 'vk.reminder'), String(extraText || '').trim()].filter(Boolean).join('\n\n');
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

function detectVkTokenGroupMismatch(expectedGroupId, conversationsData) {
  const expected = String(expectedGroupId || '').replace(/^-/, '');
  const items = conversationsData?.response?.items || [];
  const ownerIds = new Set();
  for (const item of items) {
    const fromId = Number(item?.last_message?.from_id || 0);
    if (fromId < 0) ownerIds.add(String(Math.abs(fromId)));
  }
  if (!expected) return { ok: false, reason: 'VK_GROUP_ID is empty', ownerGroupId: '' };
  if (!ownerIds.size) return { ok: true, reason: 'no outgoing conversation owner detected', ownerGroupId: '' };
  if (ownerIds.has(expected)) return { ok: true, reason: 'token owner matches VK_GROUP_ID', ownerGroupId: expected };
  return { ok: false, reason: `VK_GROUP_TOKEN appears to belong to group ${Array.from(ownerIds).join(',')}, not ${expected}`, ownerGroupId: Array.from(ownerIds).join(',') };
}

async function ensureVkGroupTokenMatchesConfig({ force = false } = {}) {
  if (!config.vkGroupId || !config.vkGroupToken || config.vkGroupToken === 'replace_me' || config.vkGroupToken.startsWith('test-') || config.nodeEnv === 'test') return { ok: true, reason: 'dry-run or not configured', ownerGroupId: '' };
  const now = Date.now();
  if (!force && tokenOwnerCheck.ok !== null && now - tokenOwnerCheck.checkedAt < 300000) return tokenOwnerCheck;
  try {
    const conversations = await callVk('messages.getConversations', { count: '10' });
    const detected = detectVkTokenGroupMismatch(config.vkGroupId, conversations);
    tokenOwnerCheck = { ...detected, checkedAt: now };
    if (!detected.ok) console.error('VK_GROUP_TOKEN/VK_GROUP_ID mismatch:', detected.reason);
    return tokenOwnerCheck;
  } catch (error) {
    tokenOwnerCheck = { checkedAt: now, ok: null, ownerGroupId: '', reason: `owner check failed: ${error.message}` };
    console.error('VK group token owner check failed:', error.message);
    return tokenOwnerCheck;
  }
}

function vkMessagesConfigured() {
  if (!config.vkGroupId || !config.vkGroupToken) return false;
  if (tokenOwnerCheck.ok === false) return false;
  return true;
}

async function sendVkReminder(vkUserId, locale, extraText = '') {
  if (!vkUserId) throw new Error('VK user id is missing');
  const ownerCheck = await ensureVkGroupTokenMatchesConfig();
  if (ownerCheck.ok === false) {
    const error = new Error('VK_GROUP_TOKEN does not match VK_GROUP_ID');
    error.code = 'VK_GROUP_TOKEN_MISMATCH';
    error.vkMessage = ownerCheck.reason;
    throw error;
  }
  const basePayload = {
    user_id: String(vkUserId),
    random_id: crypto.randomInt(1, 2147483647),
    message: reminderText(locale, extraText),
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

module.exports = { callVk, sendVkReminder, reminderText, reminderKeyboard, vkAppUrl, detectVkTokenGroupMismatch, ensureVkGroupTokenMatchesConfig, vkMessagesConfigured };
