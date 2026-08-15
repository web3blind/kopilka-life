const path = require('path');
const express = require('express');
const config = require('./config');
const { initDatabase } = require('./db');
const apiRoutes = require('./routes/api');
const webhookRoutes = require('./routes/webhook');
const { startRemindersScheduler } = require('./scheduler/remindersScheduler');
const { createRateLimiter } = require('./middleware/rateLimit');

function createApp() {
  initDatabase();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', createRateLimiter({ windowMs: config.rateLimits.apiWindowMs, max: config.rateLimits.apiMax, keyPrefix: 'api' }));
  app.use('/telegram', createRateLimiter({ windowMs: config.rateLimits.webhookWindowMs, max: config.rateLimits.webhookMax, keyPrefix: 'webhook' }));
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api', apiRoutes);
  app.use('/telegram', webhookRoutes);
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    console.error('Unhandled request error:', err?.message || err);
    return res.status(500).json({ error: 'internal error' });
  });
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => console.log(`Kopilka Life listening on http://localhost:${config.port}`));
  if (config.schedulerEnabled) startRemindersScheduler();
}
module.exports = { createApp };
