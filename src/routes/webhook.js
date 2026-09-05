const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { sendStart, answerInlineQuery } = require('../telegram');
const { claimUpdate, markUpdateDone, markUpdateFailed } = require('../services/telegramUpdatesService');
const router = express.Router();

function verifyWebhookSecret(req, res, next) {
  if (!config.telegramWebhookSecret && !config.isProduction) return next();
  const supplied = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
  const expected = Buffer.from(String(config.telegramWebhookSecret || ''));
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(403).json({ ok: false });
  return next();
}

router.post('/webhook', async (req, res) => {
  const update = req.body || {};
  let claim;
  try {
    claim = claimUpdate(update.update_id);
  } catch (_) {
    return res.status(400).json({ ok: false });
  }
  if (!claim.claimed) {
    if (claim.done) return res.json({ ok: true, duplicate: true, done: true });
    res.set('Retry-After', String(Math.max(1, Math.ceil((claim.retryAfterMs || 1000) / 1000))));
    return res.status(503).json({ ok: false, retryable: true });
  }
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
    if (!markUpdateDone(update.update_id, claim.attempt)) throw new Error('Telegram update claim was superseded');
    res.json({ ok: true });
  } catch (error) {
    markUpdateFailed(update.update_id, claim.attempt, error && error.message ? error.message : error);
    console.error('Webhook error:', error.message);
    res.status(500).json({ ok: false });
  }
});
module.exports = { router, verifyWebhookSecret };
