const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const template = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

function landingHtml(region, { vk = false } = {}) {
  const available = config.googleClientId && config.googleClientSecret
    ? template : template.replace(/<!-- GOOGLE_AUTH_BEGIN -->[\s\S]*?<!-- GOOGLE_AUTH_END -->/g, '');
  const html = region === 'global' ? available : available.replace(/<!-- GLOBAL_AUTH_BEGIN -->[\s\S]*?<!-- GLOBAL_AUTH_END -->/, '')
    .replace(/<!-- GLOBAL_SETTINGS_AUTH_BEGIN -->[\s\S]*?<!-- GLOBAL_SETTINGS_AUTH_END -->/, '')
    .replace('data-i18n="loginIntro"', 'data-i18n="loginIntroRegional"')
    .replace('Вход через Telegram или VK ID связывает сайт, бота и Mini App с одним аккаунтом.', 'Войди через e-mail или VK ID, чтобы сохранить свои отметки.')
    .replace('data-i18n="sessionRecoveryHint"', 'data-i18n="sessionRecoveryHintRegional"')
    .replace('Войди через VK ID или снова открой приложение в Telegram.', 'Войди через e-mail или VK ID.');
  // The VK shell does not use IP geolocation; keep DB-IP credits on web pages
  // that actually use the free database, but not in the VK-delivered shell.
  return vk ? html.replace(/<p id="(?:loginIpAttribution|appIpAttribution)"[^>]*>[\s\S]*?<\/p>/g, '') : html;
}
module.exports = { landingHtml };
