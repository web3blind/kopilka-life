const express = require('express');
const { createRateLimiter } = require('../middleware/rateLimit');
const partner = require('../services/partnerService');
const router = express.Router();
// Mounted before the global JSON parser: smaller body bound applies before allocation.
router.post('/api/partners/inquiries', createRateLimiter({ max: 10, windowMs: 3600000, keyPrefix: 'partner' }),
  (req,res,next) => {
    res.set('Cache-Control','no-store');
    if (req.get('origin') !== partner.origin() || (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin')) return res.status(403).json({ code: 'ORIGIN_REJECTED' });
    if (!req.is('application/json')) return res.status(415).json({ code: 'JSON_REQUIRED' });
    next();
  }, express.json({ limit: '12kb', strict: true }), async (req,res) => {
    try { const id = await partner.submitInquiry(req.body,req.ip); return res.status(202).json({ id, saved: true }); }
    catch (error) {
      if (error.status === 429) res.set('Retry-After','3600');
      return res.status(error.status || 503).json({ code: error.status ? error.message : 'PARTNER_UNAVAILABLE' });
    }
  });
router.use((err,req,res,next) => {
  if (req.path !== '/api/partners/inquiries') return next(err);
  return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ code: 'INVALID_BODY' });
});
module.exports = router;
