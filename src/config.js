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
  telegramLoginWidgetEnabled: process.env.TELEGRAM_LOGIN_WIDGET_ENABLED === 'true',
  vkAppId: process.env.VK_APP_ID || '',
  vkSecureKey: process.env.VK_SECURE_KEY || '',
  vkOAuthClientId: process.env.VK_OAUTH_CLIENT_ID || '',
  vkOAuthClientSecret: process.env.VK_OAUTH_CLIENT_SECRET || '',
  vkAuthMaxAgeSeconds: Number(process.env.VK_AUTH_MAX_AGE_SECONDS || 86400),
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'kopilka-life.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
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
