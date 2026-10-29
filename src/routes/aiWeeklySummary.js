const express = require('express');
const config = require('../config');
const { inspectActiveToken } = require('../auth/session');
const service = require('../services/aiWeeklySummaryService');
const router = express.Router();
router.use((req,res,next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  next();
});
function authorized(req) {
  const inspected = inspectActiveToken((req.get('authorization') || '').replace(/^Bearer\s+/i,''));
  return inspected.status === 'valid' && inspected.userId === req.user?.id;
}
router.use((req,res,next) => {
  if (!authorized(req)) return res.status(401).json({ code:'SESSION_INVALID' });
  if (req.method === 'GET') return next();
  let origin;
  try { origin = new URL(config.appBaseUrl).origin; } catch (_) { return res.status(403).json({ code:'ORIGIN_REJECTED' }); }
  if (req.get('origin') !== origin || (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin')) return res.status(403).json({ code:'ORIGIN_REJECTED' });
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ code:'JSON_REQUIRED' });
  next();
});
router.get('/', (req,res) => {
  try { return res.json(service.read(req.user.id,new Date(),req.query)); }
  catch (error) { return res.status(error.status || 503).json({code:error.status ? error.safeCode : 'AI_UNAVAILABLE'}); }
});
router.post('/', async (req,res) => {
  try {
    const result = await service.create(req.user.id, req.body, () => authorized(req));
    if (!authorized(req)) return res.status(401).json({ code:'SESSION_INVALID' });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 503).json({ code: error.status ? error.safeCode : 'AI_UNAVAILABLE' });
  }
});
router.delete('/:id', (req,res) => {
  try { return res.json(service.remove(req.user.id, req.params.id)); }
  catch (error) { return res.status(error.status || 503).json({ code:error.status ? error.safeCode : 'AI_UNAVAILABLE' }); }
});
module.exports = router;
