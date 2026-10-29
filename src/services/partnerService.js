const crypto = require('node:crypto');
const config = require('../config');
const { getDb } = require('../db');
const CONSENT_VERSION = 'partner-2026-10-25';
const RETENTION_MS = 90 * 86400000;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function origin() { return new URL(config.appBaseUrl).origin; }
function configured() {
  return Boolean(config.turnstileSiteKey && config.turnstileSecretKey && /^[1-9]\d{0,15}$/.test(config.partnerOwnerId) && config.botToken && config.telegramWebhookSecret && config.resendApiKey);
}
function invalid() { const e = new Error('INVALID_INQUIRY'); e.status = 400; throw e; }
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  for (const k of ['name','email','message','submissionKey','captchaToken','website']) if (typeof body[k] !== 'string') invalid();
  const name = body.name.trim(), email = body.email.trim().toLowerCase(), message = body.message.trim();
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name) ||
      email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
      !message || message.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message) ||
      !/^[a-f0-9-]{36}$/.test(body.submissionKey) || body.captchaToken.length > 2048 || body.website ||
      body.consent !== true || !['ru','en'].includes(body.locale)) invalid();
  return { name, email, message, locale: body.locale };
}
async function verifyCaptcha(token) {
  if (!config.turnstileSecretKey || !token) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: config.turnstileSecretKey, response: token }), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return false;
    const data = await response.json();
    const age = Date.now() - Date.parse(data.challenge_ts);
    return data.success === true && data.action === 'partner_inquiry' &&
      data.hostname === new URL(origin()).hostname && age >= -60000 && age <= 300000;
  } catch (_) { return false; }
}
async function submitInquiry(body, ip) {
  const fields = validate(body), db = getDb();
  if (!configured()) { const e = new Error('PARTNER_UNAVAILABLE'); e.status = 503; throw e; }
  const contentHash = hash(JSON.stringify(fields));
  const previous = db.prepare('SELECT id,content_hash FROM partner_inquiries WHERE submission_key=?').get(body.submissionKey);
  if (previous) {
    if (previous.content_hash !== contentHash) invalid();
    return previous.id;
  }
  const ipHash = crypto.createHmac('sha256', config.sessionSecret).update(String(ip)).digest('hex');
  const now = Date.now();
  function checkLimits() {
    const ipCount = db.prepare('SELECT count(*) AS n FROM partner_inquiries WHERE ip_hash=? AND created_at>?').get(ipHash, now - 3600000).n;
    const emailCount = db.prepare('SELECT count(*) AS n FROM partner_inquiries WHERE email=? AND created_at>?').get(fields.email, now - 86400000).n;
    const total = db.prepare('SELECT count(*) AS n FROM partner_inquiries WHERE created_at>?').get(now - 86400000).n;
    if (ipCount >= 5 || emailCount >= 3 || total >= 200) { const e = new Error('PARTNER_RATE_LIMIT'); e.status = 429; throw e; }
  }
  checkLimits();
  if (!await verifyCaptcha(body.captchaToken)) { const e = new Error('CAPTCHA_REJECTED'); e.status = 400; throw e; }
  return db.transaction(() => {
    // Recheck after asynchronous verification; the single-process HTTP server can interleave submissions.
    const existing = db.prepare('SELECT id,content_hash FROM partner_inquiries WHERE submission_key=?').get(body.submissionKey);
    if (existing) { if (existing.content_hash !== contentHash) invalid(); return existing.id; }
    checkLimits();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO partner_inquiries(id,submission_key,content_hash,name,email,message,locale,consent_version,created_at,ip_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,body.submissionKey,contentHash,fields.name,fields.email,fields.message,fields.locale,CONSENT_VERSION,now,ipHash);
    db.prepare("INSERT INTO partner_outbox(id,inquiry_id,kind,due_at) VALUES(?,?,'telegram',?)").run(crypto.randomUUID(),id,now);
    return id;
  })();
}
function acceptOwnerReply(update) {
  const m = update.message; // Edited/forwarded messages are never authority.
  if (!/^[1-9]\d{0,15}$/.test(config.partnerOwnerId) || !m || m.chat?.type !== 'private' ||
      String(m.from?.id) !== config.partnerOwnerId || String(m.chat?.id) !== config.partnerOwnerId ||
      m.from?.is_bot || m.forward_origin || !Number.isSafeInteger(m.message_id) || m.message_id <= 0 ||
      !Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(m.reply_to_message?.message_id) ||
      typeof m.text !== 'string' || !m.text.trim() || m.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.text)) return false;
  const db = getDb();
  return db.transaction(() => {
    const inquiry = db.prepare('SELECT id FROM partner_inquiries WHERE notification_chat=? AND notification_message=?').get(config.partnerOwnerId,m.reply_to_message.message_id);
    if (!inquiry) return false;
    db.prepare(`INSERT OR IGNORE INTO partner_outbox(id,inquiry_id,kind,reply_update,reply_message,body,due_at)
      VALUES(?,?,'email',?,?,?,?)`).run(crypto.randomUUID(),inquiry.id,update.update_id,m.message_id,m.text.trim(),Date.now());
    return true;
  })();
}
// Closed-vocabulary diagnostics only: no provider body/error/PII is logged or persisted.
async function deliver(job, inquiry) {
  if (config.nodeEnv === 'test') return { state: 'failed', error: 'TEST_SEND_DISABLED' };
  const telegram = job.kind === 'telegram';
  if (telegram ? !(config.botToken && /^[1-9]\d{0,15}$/.test(config.partnerOwnerId)) : !config.resendApiKey) return { state: 'retry', error: 'CONFIG_MISSING' };
  const notification = inquiry.locale === 'en'
    ? `Partnership inquiry ${inquiry.id}\n${inquiry.name}\n${inquiry.email}\n\n${inquiry.message}\n\nConsent: ${inquiry.consent_version}; ${new Date(inquiry.created_at).toISOString()}\nReply to this exact message: your text will be e-mailed to the customer on behalf of Life Harbor.`
    : `Партнёрская заявка ${inquiry.id}\n${inquiry.name}\n${inquiry.email}\n\n${inquiry.message}\n\nСогласие: ${inquiry.consent_version}; ${new Date(inquiry.created_at).toISOString()}\nОтветь reply на это сообщение: текст будет отправлен заказчику от имени Копилки жизни.`;
  const url = telegram ? `https://api.telegram.org/bot${config.botToken}/sendMessage` : 'https://api.resend.com/emails';
  const headers = { 'Content-Type': 'application/json' };
  if (!telegram) { headers.Authorization = `Bearer ${config.resendApiKey}`; headers['Idempotency-Key'] = `kopilka-partner-${job.id}`; }
  const body = telegram ? { chat_id: config.partnerOwnerId, text: notification, link_preview_options: { is_disabled: true } } : {
    from: config.emailFrom, reply_to: config.emailReplyTo, to: [inquiry.email],
    subject: inquiry.locale === 'en' ? 'Life Harbor — partnership inquiry' : 'Копилка жизни — партнёрская заявка',
    text: `${inquiry.locale === 'en' ? 'Reply from Life Harbor' : 'Ответ от сервиса «Копилка жизни»'}\n\n${job.body}\n\n${inquiry.locale === 'en' ? 'Inquiry' : 'Заявка'}: ${inquiry.id}`
  };
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (response.status === 429) return { state: 'retry', error: 'PROVIDER_RATE_LIMIT' };
    if (response.status >= 400 && response.status < 500) return { state: 'failed', error: 'PROVIDER_REJECTED' };
    if (!response.ok) return { state: 'unknown', error: 'PROVIDER_UNKNOWN' };
    if (telegram) {
      if (data.ok !== true || !Number.isSafeInteger(data.result?.message_id) || String(data.result?.chat?.id) !== config.partnerOwnerId) return { state: 'unknown', error: 'PROVIDER_UNKNOWN' };
      return { state: 'sent', providerId: String(data.result.message_id), chat: config.partnerOwnerId };
    }
    if (typeof data.id !== 'string' || data.id.length > 200 || !/^[\w-]+$/.test(data.id)) return { state: 'unknown', error: 'PROVIDER_UNKNOWN' };
    return { state: 'sent', providerId: data.id };
  } catch (_) { return { state: 'unknown', error: 'TRANSPORT_UNKNOWN' }; }
}
let working = false;
async function processPartnerOutbox() {
  if (working) return;
  working = true;
  try {
    const db = getDb();
    // A crashed in-flight attempt might already be accepted. Never reclaim for sending.
    db.prepare("UPDATE partner_outbox SET state='unknown',error_code='INTERRUPTED' WHERE state='sending' AND started_at<?").run(Date.now()-60000);
    db.prepare('DELETE FROM partner_inquiries WHERE created_at<?').run(Date.now()-RETENTION_MS);
    for (let i=0;i<10;i++) {
      const job = db.prepare("SELECT * FROM partner_outbox WHERE state IN ('pending','retry') AND due_at<=? ORDER BY due_at,id LIMIT 1").get(Date.now());
      if (!job) break;
      if (!db.prepare("UPDATE partner_outbox SET state='sending',attempts=attempts+1,started_at=? WHERE id=? AND state IN ('pending','retry')").run(Date.now(),job.id).changes) continue;
      const inquiry = db.prepare('SELECT * FROM partner_inquiries WHERE id=?').get(job.inquiry_id);
      const result = await deliver(job,inquiry);
      db.transaction(() => {
        const state = result.state === 'retry' && job.attempts >= 9 ? 'failed' : result.state;
        db.prepare("UPDATE partner_outbox SET state=?,provider_id=?,error_code=?,due_at=? WHERE id=? AND state='sending'").run(state,result.providerId||null,result.error||null,Date.now()+Math.min(3600000,60000 * 2 ** job.attempts),job.id);
        if (job.kind === 'telegram' && state === 'sent') db.prepare('UPDATE partner_inquiries SET notification_chat=?,notification_message=? WHERE id=?').run(result.chat,Number(result.providerId),inquiry.id);
      })();
    }
  } finally { working = false; }
}
module.exports = { CONSENT_VERSION, origin, configured, validate, verifyCaptcha, submitInquiry, acceptOwnerReply, processPartnerOutbox };
