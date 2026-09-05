const path = require('path');
const express = require('express');
const config = require('./config');
const { initDatabase } = require('./db');
const apiRoutes = require('./routes/api');
const { router: webhookRoutes, verifyWebhookSecret } = require('./routes/webhook');
const { startRemindersScheduler } = require('./scheduler/remindersScheduler');
const { ensureVkGroupTokenMatchesConfig } = require('./vkMessages');
const { createRateLimiter } = require('./middleware/rateLimit');

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
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes);
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    console.error('Unhandled request error:', err?.message || err);
    return res.status(500).json({ error: 'internal error' });
  });
  // Public profile page (SPA): /p/CODE serves the same shell; the client renders
  // the public profile by reading the path. API/webhook routes are handled above.
  app.get('/p/:code', (req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => console.log(`Kopilka Life listening on http://localhost:${config.port}`));
  ensureVkGroupTokenMatchesConfig({ force: true }).catch((error) => console.error('VK group token startup check failed:', error.message));
  if (config.schedulerEnabled) startRemindersScheduler();
}
module.exports = { createApp };
