const path = require('path');
const express = require('express');
const config = require('./config');
const { initDatabase } = require('./db');
const apiRoutes = require('./routes/api');
const { router: webhookRoutes, verifyWebhookSecret } = require('./routes/webhook');
const { startRemindersScheduler } = require('./scheduler/remindersScheduler');
const { ensureVkGroupTokenMatchesConfig } = require('./vkMessages');
const { createRateLimiter } = require('./middleware/rateLimit');
const { countryFromIp, siteRegion } = require('./services/countryService');
const { landingHtml } = require('./services/landingHtmlService');
const { validateVkLaunchParams } = require('./auth/validateVkLaunchParams');
const { inspectActiveToken } = require('./auth/session');
const { getUserById } = require('./services/usersService');
const { t } = require('./i18n');

function hasVerifiedVkLaunch(req) {
  try {
    const search = new URL(req.originalUrl, 'http://localhost').search;
    if (!search) return false;
    validateVkLaunchParams(search, config.vkSecureKey, { appId: config.vkAppId, maxAgeSeconds: config.vkAuthMaxAgeSeconds });
    return true;
  } catch (_) { return false; }
}

function createApp() {
  config.validateRuntimeConfig();
  initDatabase();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use('/telegram', createRateLimiter({ windowMs: config.rateLimits.webhookWindowMs, max: config.rateLimits.webhookMax, keyPrefix: 'webhook' }), verifyWebhookSecret, express.json({ limit: '64kb' }), webhookRoutes);
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', createRateLimiter({ windowMs: config.rateLimits.apiWindowMs, max: config.rateLimits.apiMax, keyPrefix: 'api' }));
  // Do not cache the HTML shell (it references versioned assets) so updates apply
  // immediately in Telegram's WebView instead of serving a stale cached app.js.
  app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || /^\/p\//.test(req.path))) res.set('Cache-Control', 'no-store');
    return next();
  });
  app.get(['/', '/index.html', '/p/:code'], (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const vk = hasVerifiedVkLaunch(req);
    res.type('html').send(vk ? landingHtml('ru', { vk: true }) : landingHtml(siteRegion(countryFromIp(req.ip))));
  });
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes);
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') {
      // The parser runs before API auth. Read only the verified session's saved
      // locale, just as authRequired does; never inspect the rejected body or
      // trust a submitted user/locale. Missing or invalid sessions default to RU.
      const inspected = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
      const locale = inspected.status === 'valid' ? getUserById(inspected.userId)?.locale : undefined;
      return res.status(413).json({ error: t(locale, 'error.inputTooLarge'), code: 'PAYLOAD_TOO_LARGE' });
    }
    console.error('Unhandled request error:', err?.message || err);
    return res.status(500).json({ error: 'internal error' });
  });
  // Public profiles use the same country-aware shell above.
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
if (require.main === module) {
  const app = createApp();
  app.listen(config.port, config.isProduction ? '127.0.0.1' : '0.0.0.0', () => console.log(`Kopilka Life listening on http://localhost:${config.port}`));
  ensureVkGroupTokenMatchesConfig({ force: true }).catch((error) => console.error('VK group token startup check failed:', error.message));
  if (config.schedulerEnabled) startRemindersScheduler();
}
module.exports = { createApp };
