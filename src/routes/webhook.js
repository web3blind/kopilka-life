const express = require('express');
const config = require('../config');
const { createRateLimiter } = require('../middleware/rateLimit');
const { sendStart, answerInlineQuery } = require('../telegram');
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
    // Inline mode: user picked a chat via switchInlineQuery; answer with the
    // shared text so it can be sent to the chosen chat.
    if (update.inline_query && update.inline_query.id && update.inline_query.query) {
      const sharedText = update.inline_query.query.trim();
      if (sharedText) await answerInlineQuery(update.inline_query.id, sharedText, update.inline_query.from?.language_code || 'ru');
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).json({ ok: false });
  }
});
module.exports = router;
