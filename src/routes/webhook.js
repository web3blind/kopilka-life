const express = require('express');
const config = require('../config');
const { createRateLimiter } = require('../middleware/rateLimit');
const { sendStart } = require('../telegram');
const router = express.Router();
const webhookLimiter = createRateLimiter({ keyPrefix: 'webhook', windowMs: config.rateLimits.webhookWindowMs, max: config.rateLimits.webhookMax });
router.post('/webhook', webhookLimiter, async (req, res) => {
  const update = req.body || {};
  const message = update.message || update.edited_message;
  const text = message?.text || '';
  const chatId = message?.chat?.id;
  const locale = message?.from?.language_code || 'ru';
  try {
    if (chatId && text.startsWith('/start')) await sendStart(chatId, locale);
    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ ok: false });
  }
});
module.exports = router;
