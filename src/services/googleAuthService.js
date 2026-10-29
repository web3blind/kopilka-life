const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { getDb } = require('../db');
const config = require('../config');
const { appOrigin } = require('../auth/vkOAuth');
const { resolveRefCode, ensureRefCode } = require('./usersService');
const { normalizeLocale } = require('../i18n');
const { normalizeTimezone } = require('../time');
const { gmailSubject, findEmailIdentity } = require('./emailAuthService');
const { sessionHash, createOffer } = require('./identityMergeService');
const { inspectActiveToken } = require('../auth/session');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const redirectUri = () => `${appOrigin()}/api/auth/google/callback`;
// The hash alone binds an offer to a bearer but cannot detect a revision revoked
// while Google is open. Keep the initiating revision alongside the hash in both
// one-time rows; do not put the bearer or its signed payload in the OAuth URL.
function assertGoogleLinkProof(context) {
  if (!context.user_id) return null;
  const match = /^(0|[1-9]\d*):([a-f0-9]{64})$/.exec(context.session_hash || '');
  const revision = getDb().prepare('SELECT session_revision FROM users WHERE id = ?').get(context.user_id)?.session_revision;
  if (!match || !Number.isSafeInteger(Number(match[1])) || revision !== Number(match[1]) ||
      getDb().prepare('SELECT 1 FROM session_revocations WHERE token_hash = ?').get(match[2])) throw new Error('Google link session revoked');
  return match[2];
}
function createGoogleIntent({ userId = null, session = '', refCode = '', timezone = '', locale = 'ru' }) {
  if (!config.googleClientId || !config.googleClientSecret) throw new Error('Google OAuth is not configured');
  const proof = userId ? inspectActiveToken(session) : null;
  if (userId && (proof.status !== 'valid' || proof.userId !== userId)) throw new Error('Google link session revoked');
  const intent = random(), channel = random();
  const db = getDb();
  db.prepare('DELETE FROM google_oauth_intents WHERE expires_at < ?').run(Math.floor(Date.now()/1000));
  db.prepare(`INSERT INTO google_oauth_intents (intent_hash,channel,user_id,ref_code,timezone,locale,expires_at,session_hash)
    VALUES (?,?,?,?,?,?,?,?)`).run(digest(intent), channel, userId, String(refCode).slice(0,64), String(timezone).slice(0,80), normalizeLocale(locale), Math.floor(Date.now()/1000)+600, userId ? `${proof.revision === undefined ? 0 : proof.revision}:${sessionHash(session)}` : null);
  return { launchUrl: `${appOrigin()}/api/auth/google/authorize?intent=${encodeURIComponent(intent)}`, channel };
}
function beginGoogleIntent(intent, browser) {
  if (typeof intent !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(intent)) throw new Error('Invalid Google intent');
  if (typeof browser !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(browser)) throw new Error('Invalid Google browser');
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM google_oauth_intents WHERE intent_hash = ?').get(digest(intent));
    if (!row || row.expires_at < Date.now()/1000) throw new Error('Invalid Google intent');
    assertGoogleLinkProof(row);
    db.prepare('DELETE FROM google_oauth_intents WHERE intent_hash = ?').run(digest(intent));
    return beginGoogleAuth({ browser, userId: row.user_id, refCode: row.ref_code, timezone: row.timezone, locale: row.locale, channel: row.channel, sessionHashValue: row.session_hash });
  })();
}
function beginGoogleAuth({ browser, userId = null, refCode = '', timezone = '', locale = 'ru', channel = null, sessionHashValue = null }) {
  if (!config.googleClientId || !config.googleClientSecret) throw new Error('Google OAuth is not configured');
  const state = random(), nonce = random(), verifier = random();
  getDb().prepare('DELETE FROM google_oauth_states WHERE expires_at < ?').run(Date.now() / 1000);
  getDb().prepare(`INSERT INTO google_oauth_states (state_hash,browser_hash,nonce,code_verifier,user_id,ref_code,timezone,locale,expires_at,handoff_channel,session_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(digest(state), digest(browser), nonce, verifier, userId, String(refCode).slice(0,64), String(timezone).slice(0,80), normalizeLocale(locale), Math.floor(Date.now()/1000)+600, channel, sessionHashValue);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const params = { client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email profile', state, nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
function consumeGoogleState(state, browser) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !browser) throw new Error('Invalid OAuth state');
  return getDb().transaction(() => {
    const row = getDb().prepare('SELECT * FROM google_oauth_states WHERE state_hash = ?').get(digest(state));
    if (!row || row.browser_hash !== digest(browser) || row.expires_at < Date.now()/1000) throw new Error('Invalid OAuth state');
    getDb().prepare('DELETE FROM google_oauth_states WHERE state_hash = ?').run(digest(state));
    return row;
  })();
}
async function exchangeGoogleCode(code, row) {
  if (typeof code !== 'string' || code.length > 2048 || !code) throw new Error('Invalid authorization code');
  const body = new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
    redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: row.code_verifier });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Google token exchange failed');
  const tokens = await response.json();
  if (!tokens.id_token) throw new Error('Missing Google ID token');
  const ticket = await new OAuth2Client(config.googleClientId).verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
  const profile = ticket.getPayload();
  if (!profile?.sub || !profile.email_verified || profile.nonce !== row.nonce) throw new Error('Invalid Google identity');
  return profile;
}
function resolveGoogleUser(profile, context, session = '') {
  const db = getDb();
  return db.transaction(() => {
    // Direct service callers may supply legacy contexts; the HTTP callback
    // requires the revision-bearing proof before reaching this transaction.
    if (context.user_id && /^\d+:/.test(context.session_hash || '')) assertGoogleLinkProof(context);
    const found = db.prepare("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = ?").get(profile.sub);
    const gmail = profile.email_verified === true && profile.email ? gmailSubject(profile.email) : null;
    const emailIdentity = gmail ? findEmailIdentity(db, gmail) : null;
    const targetId = context.user_id || found?.user_id || emailIdentity?.user_id;
    if (found && targetId !== found.user_id) {
      if (!context.user_id || !context.session_hash ||
          (emailIdentity && emailIdentity.user_id !== found.user_id)) throw new Error('Google identity belongs to another account');
      return { mergeOffer: createOffer({ currentId: context.user_id, provider: 'google', subject: profile.sub, sessionHashValue: context.session_hash.split(':').at(-1) }) };
    }
    if (emailIdentity && targetId !== emailIdentity.user_id) {
      if (!context.user_id || !context.session_hash) throw new Error('Gmail identity belongs to another account');
      return { mergeOffer: createOffer({ currentId: context.user_id, provider: 'email', subject: emailIdentity.subject, sessionHashValue: context.session_hash.split(':').at(-1) }) };
    }
    if (targetId) {
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) throw new Error('Linked account missing');
      if (gmail) {
        const existingEmail = db.prepare("SELECT subject FROM login_identities WHERE provider = 'email' AND user_id = ?").get(targetId);
        if (existingEmail && gmailSubject(existingEmail.subject) !== gmail) throw new Error('Gmail identity belongs to another account');
        if (!emailIdentity) db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email',?,?)").run(gmail, targetId);
      }
      if (!found) db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('google',?,?)").run(profile.sub, targetId);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    }
    const referrer = resolveRefCode(context.ref_code);
    const name = String(profile.given_name || 'Человек').replace(/[<>\p{Cc}]/gu, '').slice(0, 60) || 'Человек';
    const info = db.prepare(`INSERT INTO users (telegram_id,first_name,username,timezone,locale,reminders_enabled,is_demo,referrer_id)
      VALUES (?,?,?,?,?,0,0,?)`).run(`google:${crypto.randomUUID()}`, name, '', normalizeTimezone(context.timezone), normalizeLocale(context.locale), referrer?.id || null);
    db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('google',?,?)").run(profile.sub, info.lastInsertRowid);
    if (gmail) db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email',?,?)").run(gmail, info.lastInsertRowid);
    ensureRefCode(info.lastInsertRowid);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  })();
}
module.exports = { createGoogleIntent, beginGoogleIntent, beginGoogleAuth, consumeGoogleState, assertGoogleLinkProof, exchangeGoogleCode, resolveGoogleUser };
