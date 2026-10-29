const express = require('express');
const config = require('../config');
const { revokeToken } = require('../auth/session');
const router = express.Router();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  next();
});
router.post('/', (req, res) => {
  let origin;
  try { origin = new URL(config.appBaseUrl).origin; }
  catch (_) { return res.status(403).json({ code: 'ORIGIN_REJECTED' }); }
  if (req.get('origin') !== origin || (req.get('sec-fetch-site') && req.get('sec-fetch-site') !== 'same-origin'))
    return res.status(403).json({ code: 'ORIGIN_REJECTED' });
  if (!req.is('application/json')) return res.status(415).json({ code: 'JSON_REQUIRED' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)
    return res.status(400).json({ code: 'INVALID_LOGOUT_REQUEST' });
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match) return res.status(401).json({ code: 'SESSION_INVALID' });
  const result = revokeToken(match[1]);
  if (result.status !== 'revoked')
    return res.status(401).json({ code: result.status === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_INVALID' });
  return res.json({ loggedOut: true });
});
module.exports = router;
