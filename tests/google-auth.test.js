const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OAuth2Client } = require('google-auth-library');
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.WEBAPP_URL = 'https://life.blinddev.xyz';
const { initDatabase, closeDb, getDb } = require('../src/db');
const { upsertTelegramUser } = require('../src/services/usersService');
const { requestEmailCode, verifyEmailCode } = require('../src/services/emailAuthService');
const { createEntry } = require('../src/services/entriesService');
const { createGoogleIntent, beginGoogleIntent, beginGoogleAuth, consumeGoogleState, assertGoogleLinkProof, exchangeGoogleCode, resolveGoogleUser } = require('../src/services/googleAuthService');
const { createToken } = require('../src/auth/session');
const { readOffer } = require('../src/services/identityMergeService');
test('Google state is browser-bound and identities never auto-merge by email', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'google-auth-'));
  initDatabase(path.join(dir, 'db.sqlite'));
  try {
    const old = upsertTelegramUser({ id: 101, first_name: 'Старый' });
    const url = new URL(beginGoogleAuth({ browser: 'browser-random-string', userId: old.id }));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('prompt'), 'select_account', 'Google must offer account selection, including linking');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://life.blinddev.xyz/api/auth/google/callback');
    assert.throws(() => consumeGoogleState(url.searchParams.get('state'), 'wrong-browser'));
    const context = consumeGoogleState(url.searchParams.get('state'), 'browser-random-string');
    assert.throws(() => consumeGoogleState(url.searchParams.get('state'), 'browser-random-string'));
    assert.equal(resolveGoogleUser({ sub: 'google-sub-1', email: 'same@example.com' }, context).id, old.id);
    assert.equal(getDb().prepare('SELECT telegram_id FROM users WHERE id = ?').get(old.id).telegram_id, '101');
    const newUser = resolveGoogleUser({ sub: 'google-sub-2', email: 'same@example.com' }, { ref_code: '', timezone: 'UTC', locale: 'ru' });
    assert.notEqual(newUser.id, old.id);
    assert.equal(resolveGoogleUser({ sub: 'google-sub-2' }, {}).id, newUser.id);
    assert.throws(() => resolveGoogleUser({ sub: 'google-sub-2' }, { user_id: old.id }), /another account/);
  } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
});
async function withDb(run) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'google-email-'));
  initDatabase(path.join(dir, 'db.sqlite'));
  try { await run(); } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
}
test('website Google sign-in intent offers account choice without losing browser-bound state or PKCE', async () => withDb(async () => {
  const intent = createGoogleIntent({ locale: 'en', timezone: 'UTC' });
  const browser = 'browser-account-choice-32-characters';
  const url = new URL(beginGoogleIntent(new URL(intent.launchUrl).searchParams.get('intent'), browser));
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.throws(() => consumeGoogleState(url.searchParams.get('state'), 'foreign-browser'));
  const context = consumeGoogleState(url.searchParams.get('state'), browser);
  assert.equal(context.user_id, null);
  assert.equal(context.handoff_channel, intent.channel);
  assert.equal(context.locale, 'en');
  assert.throws(() => consumeGoogleState(url.searchParams.get('state'), browser));
}));
async function otp(email, requestedBy = null) {
  let code;
  await requestEmailCode({ email, requestedBy, sender: async (_, value) => { code = value; } });
  return verifyEmailCode({ email, code, requestedBy });
}
const google = (sub, email, extra = {}) => ({ sub, email, email_verified: true, ...extra });

test('OTP first then verified Google Gmail aliases resolve the same data-bearing user', async () => withDb(async () => {
  const user = await otp('First.Last+news@googlemail.com');
  createEntry(user.id, 'joy', 'retained');
  const resolved = resolveGoogleUser(google('g-otp-first', 'firstlast@gmail.com'), {});
  assert.equal(resolved.id, user.id);
  assert.equal(getDb().prepare('SELECT user_id FROM entries WHERE note = ?').get('retained').user_id, user.id);
  assert.equal((await otp('FIRST.LAST@gmail.com')).id, user.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
}));

test('Google first then Gmail OTP opens the same account without a second user', async () => withDb(async () => {
  const user = resolveGoogleUser(google('g-first', 'First.Last@Gmail.Com'), {});
  createEntry(user.id, 'rest', 'kept');
  assert.equal((await otp('firstlast+app@googlemail.com')).id, user.id);
  assert.equal(resolveGoogleUser(google('g-first', 'firstlast@gmail.com'), {}).id, user.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(getDb().prepare('SELECT user_id FROM entries WHERE note = ?').get('kept').user_id, user.id);
}));

test('unverified Gmail and verified non-Gmail do not auto-bind an OTP identity', async () => withDb(async () => {
  const gmail = await otp('owner@gmail.com');
  const unverified = resolveGoogleUser(google('unverified', 'owner@gmail.com', { email_verified: false }), {});
  assert.notEqual(unverified.id, gmail.id);
  const other = await otp('person@custom.org');
  const nonGmail = resolveGoogleUser(google('custom', 'person@custom.org'), {});
  assert.notEqual(nonGmail.id, other.id);
}));

test('existing Google subject and OTP alias on different accounts fail closed without moving data', async () => withDb(async () => {
  const first = resolveGoogleUser(google('subject', 'unrelated@example.org'), {});
  const second = await otp('Owner.Name@gmail.com');
  createEntry(first.id, 'joy', 'google data');
  createEntry(second.id, 'rest', 'email data');
  assert.throws(() => resolveGoogleUser(google('subject', 'ownername@googlemail.com'), {}), /another account/);
  assert.equal(getDb().prepare("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = 'subject'").get().user_id, first.id);
  assert.equal(getDb().prepare('SELECT user_id FROM entries WHERE note = ?').get('email data').user_id, second.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
}));

test('explicit Google linking cannot adopt Gmail claimed by another account', async () => withDb(async () => {
  const owner = await otp('owner@gmail.com');
  const other = upsertTelegramUser({ id: 54201, first_name: 'Other' });
  assert.throws(() => resolveGoogleUser(google('linked', 'o.w.n.e.r@googlemail.com'), { user_id: other.id }), /another account/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM login_identities WHERE provider = 'google'").get().n, 0);
  assert.equal((await otp('owner+alias@gmail.com')).id, owner.id);
}));

test('legacy Gmail aliases pointing to separate accounts never auto-merge', async () => withDb(async () => {
  const a = upsertTelegramUser({ id: 54202, first_name: 'A' });
  const b = upsertTelegramUser({ id: 54203, first_name: 'B' });
  const db = getDb();
  db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email',?,?)").run('f.o.o@gmail.com', a.id);
  db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email',?,?)").run('foo@googlemail.com', b.id);
  assert.throws(() => resolveGoogleUser(google('legacy', 'foo@gmail.com'), {}), /another account/);
  await assert.rejects(otp('foo@gmail.com'), /another account/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_identities WHERE provider = 'google'").get().n, 0);
}));

test('OTP challenges remain tied to requested spelling even for the same Gmail mailbox', async () => withDb(async () => {
  let code;
  await requestEmailCode({ email: 'a.b@gmail.com', sender: async (_, value) => { code = value; } });
  assert.throws(() => verifyEmailCode({ email: 'ab@googlemail.com', code }), /код/);
  const user = verifyEmailCode({ email: 'a.b@gmail.com', code });
  assert.equal(user.id, resolveGoogleUser(google('a-b', 'ab@gmail.com'), {}).id);
}));

test('different Google subjects cannot claim an existing Gmail identity', async () => withDb(async () => {
  const original = resolveGoogleUser(google('primary', 'a.b@gmail.com'), {});
  assert.throws(() => resolveGoogleUser(google('other', 'ab@googlemail.com'), {}), /UNIQUE constraint/);
  assert.equal(resolveGoogleUser(google('primary', 'ab@gmail.com'), {}).id, original.id);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM login_identities WHERE provider = 'google'").get().n, 1);
}));

test('other domains keep dots and plus tags distinct from Gmail normalization', async () => withDb(async () => {
  const a = await otp('a.b@example.org');
  const b = await otp('ab@example.org');
  assert.notEqual(a.id, b.id);
  const custom = resolveGoogleUser(google('workspace', 'a.b@example.org'), {});
  assert.notEqual(custom.id, a.id);
}));

test('explicit linking to the same owner succeeds and conflicting OTP link rolls back', async () => withDb(async () => {
  const owner = upsertTelegramUser({ id: 54204, first_name: 'Owner' });
  const other = upsertTelegramUser({ id: 54205, first_name: 'Other' });
  assert.equal((await otp('A.B@gmail.com', owner.id)).id, owner.id);
  assert.equal(resolveGoogleUser(google('owner-google', 'ab@googlemail.com'), { user_id: owner.id }).id, owner.id);
  await assert.rejects(otp('a.b+test@gmail.com', other.id), /другому аккаунту/);
  assert.equal(getDb().prepare("SELECT user_id FROM login_identities WHERE provider = 'email'").get().user_id, owner.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
}));

test('revoked initiating session cannot authorize an in-flight free Google link', async () => withDb(async () => {
  const user = upsertTelegramUser({ id: 54500, first_name: 'Owner' });
  const session = createToken(user.id);
  const intent = createGoogleIntent({ userId: user.id, session });
  getDb().prepare('UPDATE users SET session_revision = session_revision + 1 WHERE id = ?').run(user.id);
  assert.throws(() => beginGoogleIntent(new URL(intent.launchUrl).searchParams.get('intent'), 'browser-random-string-32-characters'), /session|revoked/i);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_states').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM login_identities').get().n, 0);
}));

test('revoked initiating session cannot write a free Google identity after authorization', async () => withDb(async () => {
  const user = upsertTelegramUser({ id: 54501, first_name: 'Owner' });
  const session = createToken(user.id);
  const intent = createGoogleIntent({ userId: user.id, session });
  const url = new URL(beginGoogleIntent(new URL(intent.launchUrl).searchParams.get('intent'), 'browser-random-string-32-characters'));
  const context = consumeGoogleState(url.searchParams.get('state'), 'browser-random-string-32-characters');
  getDb().prepare('UPDATE users SET session_revision = session_revision + 1 WHERE id = ?').run(user.id);
  assert.throws(() => resolveGoogleUser(google('free-revoked', 'revoked@example.org'), context), /session|revoked/i);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM login_identities').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM account_merge_offers').get().n, 0);
}));

test('valid initiating session links free Google and issues bound occupied offer', async () => withDb(async () => {
  const current = upsertTelegramUser({ id: 54502, first_name: 'Owner' });
  const occupied = resolveGoogleUser(google('occupied-sub', 'occupied@example.org'), {});
  const session = createToken(current.id);
  const contextFor = () => {
    const intent = createGoogleIntent({ userId: current.id, session });
    const url = new URL(beginGoogleIntent(new URL(intent.launchUrl).searchParams.get('intent'), 'browser-random-string-32-characters'));
    return consumeGoogleState(url.searchParams.get('state'), 'browser-random-string-32-characters');
  };
  assert.equal(resolveGoogleUser(google('free-sub', 'free@example.org'), contextFor()).id, current.id);
  const offer = resolveGoogleUser(google('occupied-sub', 'occupied@example.org'), contextFor()).mergeOffer;
  assert.equal(readOffer(offer.mergeToken, session, current.id).other_user_id, occupied.id);
  assert.equal(getDb().prepare("SELECT user_id FROM login_identities WHERE provider = 'google' AND subject = 'occupied-sub'").get().user_id, occupied.id);
}));

test('Google link intent rejects foreign and revoked bearers; legacy state proof fails closed at callback gate', async () => withDb(async () => {
  const current = upsertTelegramUser({ id: 54503, first_name: 'Owner' });
  const other = upsertTelegramUser({ id: 54504, first_name: 'Other' });
  const session = createToken(current.id);
  assert.throws(() => createGoogleIntent({ userId: other.id, session }), /session|revoked/i);
  getDb().prepare('UPDATE users SET session_revision = session_revision + 1 WHERE id = ?').run(current.id);
  assert.throws(() => createGoogleIntent({ userId: current.id, session }), /session|revoked/i);
  assert.throws(() => assertGoogleLinkProof({ user_id: current.id, session_hash: 'a'.repeat(64) }), /session|revoked/i);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_intents').get().n, 0);
}));

test('Google ID-token nonce is checked after provider verification', async () => {
  const priorFetch = global.fetch;
  const priorVerify = OAuth2Client.prototype.verifyIdToken;
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return new Response(JSON.stringify({ id_token: 'test-id-token' }), { status: 200 });
    };
    OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => ({ sub: 'google-sub', email_verified: true, nonce: 'expected' }) });
    await assert.rejects(exchangeGoogleCode('code', { code_verifier: 'verifier', nonce: 'wrong' }), /identity/);
    assert.equal((await exchangeGoogleCode('code', { code_verifier: 'verifier', nonce: 'expected' })).sub, 'google-sub');
  } finally { global.fetch = priorFetch; OAuth2Client.prototype.verifyIdToken = priorVerify; }
});
