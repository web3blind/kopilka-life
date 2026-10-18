const crypto = require('node:crypto');
const { getDb } = require('../db');
const config = require('../config');
const { ensureRefCode, resolveRefCode } = require('./usersService');
const { sendLoginCode } = require('./emailSender');
const { normalizeLocale } = require('../i18n');
const { normalizeTimezone } = require('../time');
const { sessionHash, createOffer } = require('./identityMergeService');

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Укажи корректный адрес электронной почты.');
  return email;
}
// Gmail owns both domains; dots and plus tags do not distinguish mailboxes.
// Other domains (including Google-hosted custom domains) retain exact addresses.
function gmailSubject(email) {
  const address = normalizeEmail(email);
  const [local, domain] = address.split('@');
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return null;
  const mailbox = local.split('+')[0].replace(/\./g, '');
  if (!mailbox) throw new Error('Укажи корректный адрес электронной почты.');
  return `${mailbox}@gmail.com`;
}
function findEmailIdentity(db, address) {
  const canonical = gmailSubject(address);
  if (!canonical) return db.prepare("SELECT user_id FROM login_identities WHERE provider = 'email' AND subject = ?").get(address);
  // Include pre-normalization identities without migrating or discarding their owners.
  const rows = db.prepare("SELECT subject,user_id FROM login_identities WHERE provider = 'email' AND (subject LIKE '%@gmail.com' OR subject LIKE '%@googlemail.com')").all()
    .filter(row => gmailSubject(row.subject) === canonical);
  if (new Set(rows.map(row => row.user_id)).size > 1) throw new Error('Gmail identity belongs to another account');
  return rows[0];
}
function codeHash(email, code, salt) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`${email}\0${code}\0${salt}`).digest('hex');
}
async function requestEmailCode({ email, requestedBy = null, session = '', sender = sendLoginCode }) {
  const address = normalizeEmail(email);
  gmailSubject(address);
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  const code = crypto.randomInt(1000000).toString().padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${salt}.${codeHash(address, code, salt)}`;
  const reserved = db.transaction(() => {
    db.prepare('DELETE FROM email_login_codes WHERE window_start < ? AND expires_at < ?').run(now - 3600, now);
    const previous = db.prepare('SELECT * FROM email_login_codes WHERE email = ?').get(address);
    if (previous && now - previous.sent_at < 60) return false;
    const inWindow = previous && now - previous.window_start < 3600;
    const count = inWindow ? previous.window_count + 1 : 1;
    if (count > 5) return false;
    db.prepare(`INSERT INTO email_login_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_count, requested_by, session_hash)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
        attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start,
        window_count = excluded.window_count, requested_by = excluded.requested_by, session_hash = excluded.session_hash`)
      .run(address, hash, now + 600, now, inWindow ? previous.window_start : now, count, requestedBy, requestedBy && session ? sessionHash(session) : null);
    return true;
  })();
  if (!reserved) return;
  try { await sender(address, code); }
  catch (error) {
    db.prepare('DELETE FROM email_login_codes WHERE email = ? AND code_hash = ?').run(address, hash);
    throw error;
  }
}
function verifyEmailCode({ email, code, requestedBy = null, session = '', refCode = '', timezone = 'UTC', locale = 'ru' }) {
  const address = normalizeEmail(email);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('Неверный или просроченный код.');
  const db = getDb();
  return db.transaction(() => {
    const challenge = db.prepare('SELECT * FROM email_login_codes WHERE email = ?').get(address);
    const now = Math.floor(Date.now() / 1000);
    if (!challenge || challenge.expires_at < now || challenge.attempts >= 5 || challenge.requested_by !== requestedBy ||
        (challenge.session_hash && challenge.session_hash !== sessionHash(session))) {
      throw new Error('Неверный или просроченный код.');
    }
    const [salt, digest] = challenge.code_hash.split('.');
    const actual = codeHash(address, code, salt);
    if (!digest || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(digest))) {
      db.prepare('UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = ?').run(address);
      return null;
    }
    db.prepare("UPDATE email_login_codes SET code_hash = 'consumed', expires_at = 0, attempts = 5 WHERE email = ?").run(address);
    const identity = findEmailIdentity(db, address);
    const subject = gmailSubject(address) || address;
    if (requestedBy) {
      if (identity && identity.user_id !== requestedBy) {
        if (!session || !challenge.session_hash) throw new Error('Этот e-mail уже привязан к другому аккаунту.');
        return { mergeOffer: createOffer({ currentId: requestedBy, provider: 'email', subject: identity.subject || subject, session }) };
      }
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(requestedBy)) throw new Error('Аккаунт не найден.');
      if (!identity) db.prepare("INSERT INTO login_identities (provider, subject, user_id) VALUES ('email', ?, ?)").run(subject, requestedBy);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(requestedBy);
    }
    if (identity) return db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
    const referrer = resolveRefCode(refCode);
    const info = db.prepare(`INSERT INTO users (telegram_id, first_name, username, timezone, locale, reminders_enabled, is_demo, referrer_id)
      VALUES (?, 'Человек', '', ?, ?, 0, 0, ?)`).run(`email:${crypto.randomUUID()}`, normalizeTimezone(timezone), normalizeLocale(locale), referrer?.id || null);
    db.prepare("INSERT INTO login_identities (provider, subject, user_id) VALUES ('email', ?, ?)").run(subject, info.lastInsertRowid);
    ensureRefCode(info.lastInsertRowid);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  })();
}
module.exports = { normalizeEmail, gmailSubject, findEmailIdentity, requestEmailCode, verifyEmailCode };
