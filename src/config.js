const path = require('path');
require('dotenv').config();
const isProduction = process.env.NODE_ENV === 'production';
module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  webappUrl: process.env.WEBAPP_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  botToken: process.env.BOT_TOKEN || '',
  botUsername: process.env.BOT_USERNAME || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  telegramLoginWidgetEnabled: process.env.TELEGRAM_LOGIN_WIDGET_ENABLED === 'true',
  vkAppId: process.env.VK_APP_ID || '',
  vkSecureKey: process.env.VK_SECURE_KEY || '',
  vkOAuthClientId: process.env.VK_OAUTH_CLIENT_ID || '',
  vkOAuthClientSecret: process.env.VK_OAUTH_CLIENT_SECRET || '',
  vkOAuthAuthorizeUrl: process.env.VK_OAUTH_AUTHORIZE_URL || 'https://id.vk.ru/authorize',
  vkOAuthTokenUrl: process.env.VK_OAUTH_TOKEN_URL || 'https://id.vk.ru/oauth2/auth',
  vkGroupId: process.env.VK_GROUP_ID || '',
  vkGroupToken: process.env.VK_GROUP_TOKEN || '',
  // VK Android can reopen Mini Apps from messages/favorites with a cached
  // signed vk_ts older than 24h. Keep a bounded replay window, but allow
  // real saved-link launches to work.
  vkAuthMaxAgeSeconds: Number(process.env.VK_AUTH_MAX_AGE_SECONDS || 604800),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'kopilka-life.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
  sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS || 604800),
  vkOAuthStateMaxAgeSeconds: Number(process.env.VK_OAUTH_STATE_MAX_AGE_SECONDS || 600),
  devAuthEnabled: !isProduction && process.env.DEV_AUTH_ENABLED === 'true',
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  telegramAuthMaxAgeSeconds: Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400),
  rateLimits: {
    apiWindowMs: Number(process.env.RATE_LIMIT_API_WINDOW_MS || 60000),
    apiMax: Number(process.env.RATE_LIMIT_API_MAX || (isProduction ? 120 : 1000)),
    authWindowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS || 60000),
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX || (isProduction ? 20 : 200)),
    devWindowMs: Number(process.env.RATE_LIMIT_DEV_WINDOW_MS || 60000),
    devMax: Number(process.env.RATE_LIMIT_DEV_MAX || 200),
    webhookWindowMs: Number(process.env.RATE_LIMIT_WEBHOOK_WINDOW_MS || 60000),
    webhookMax: Number(process.env.RATE_LIMIT_WEBHOOK_MAX || (isProduction ? 120 : 1000))
  }
};

module.exports.validateRuntimeConfig = function validateRuntimeConfig(settings = module.exports) {
  if (!settings.isProduction && settings.nodeEnv !== 'production') return;
  if (!settings.sessionSecret || settings.sessionSecret === 'local-dev-secret-change-me') {
    throw new Error('SESSION_SECRET must be configured in production');
  }
  if (!Number.isFinite(settings.sessionMaxAgeSeconds) || settings.sessionMaxAgeSeconds < 300) {
    throw new Error('SESSION_MAX_AGE_SECONDS must be at least 300');
  }
  if (!settings.telegramWebhookSecret || !/^[A-Za-z0-9_-]{1,256}$/.test(settings.telegramWebhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be configured with Telegram-safe characters in production');
  }
  if (settings.vkOAuthAuthorizeUrl !== 'https://id.vk.ru/authorize' || settings.vkOAuthTokenUrl !== 'https://id.vk.ru/oauth2/auth') {
    throw new Error('VK OAuth provider endpoints cannot be overridden in production');
  }
  if (settings.vkOAuthClientId) {
    let webapp;
    try { webapp = new URL(settings.webappUrl); } catch (_) { throw new Error('WEBAPP_URL must be a valid HTTPS URL for production VK OAuth'); }
    if (webapp.protocol !== 'https:' || webapp.username || webapp.password || webapp.search || webapp.hash) {
      throw new Error('WEBAPP_URL must be a valid HTTPS URL for production VK OAuth');
    }
  }
};
