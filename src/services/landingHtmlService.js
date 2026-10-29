const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const template = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

function landingHtml(region, { vk = false, locale = 'ru' } = {}) {
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
  const seo = require('./publicSeoService');
  const english = locale === 'en';
  const title = english ? 'Life Harbor — small acts of self-care' : 'Копилка жизни — маленькие действия заботы о себе';
  const description = english ? 'A free service to notice sleep, movement, joy and gratitude, without rankings or penalties. Available on the web, Telegram and VK.' : 'Бесплатный сервис для отметок сна, движения, радости и благодарности. Без рейтингов и наказаний. Доступен на сайте, в Telegram и VK.';
  const page = html.replace(/<title>[\s\S]*?<\/title>/, seo.metadata({locale:english?'en':'ru',path:'/',title,description}).replace(/<link rel="alternate"[^>]*>/g,''))
    .replace('<html lang="ru">', english ? '<html lang="en">' : '<html lang="ru">')
    .replace(/(<p class="soft-note legal-links">)/g, `$1<a href="/about" data-i18n="legalAbout">${english ? 'About' : 'О сервисе'}</a> · <a href="/partners" data-i18n="legalPartners">${english ? 'Partnerships' : 'Партнёрам'}</a> · `);
  return vk ? page.replace(/<p id="(?:loginIpAttribution|appIpAttribution)"[^>]*>[\s\S]*?<\/p>/g, '') : page;
}
module.exports = { landingHtml };
