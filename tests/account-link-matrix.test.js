// Account-linking direction matrix. The only database is a migrated disposable SQLite file.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-link-matrix-'));
const configPath = require.resolve('../src/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
  nodeEnv: 'test', isProduction: false, schedulerEnabled: false, dbPath: path.join(dir, 'isolated.sqlite'),
  sessionSecret: 'fixture-merge-key-not-production', sessionMaxAgeSeconds: 600,
  botToken: 'fixture-bot-key', botUsername: 'fixture_bot', vkGroupToken: '', webappUrl: 'https://fixture.invalid',
  rateLimits: { storyWindowMs: 60000, storyMax: 100, authWindowMs: 60000, authMax: 100, devWindowMs: 60000, devMax: 100 }
} };
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/usersService');
const { createEntry } = require('../src/services/entriesService');
const { requestEmailCode, verifyEmailCode } = require('../src/services/emailAuthService');
const { resolveGoogleUser } = require('../src/services/googleAuthService');
const merges = require('../src/services/accountMergeService');
const { createMergeToken } = require('../src/auth/mergeToken');
const { verifyToken, createToken } = require('../src/auth/session');
const identityMerges = require('../src/services/identityMergeService');
const router = require('../src/routes/api');
let serial = 700000;
const next = () => ++serial;
const db = () => getDb();
const identityRows = id => db().prepare('SELECT provider,subject FROM login_identities WHERE user_id = ? ORDER BY provider').all(id);
const owner = (table, id) => db().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(id);
async function email(address, requestedBy = null) {
  let code;
  // Re-authentication in this fixture is intentional; bypass only the 60s send cooldown.
  db().prepare('UPDATE email_login_codes SET sent_at = sent_at - 61 WHERE email = ?').run(address.toLowerCase());
  await requestEmailCode({ email: address, requestedBy, sender: async (_address, value) => { code = value; } });
  assert.match(code, /^\d{6}$/);
  return verifyEmailCode({ email: address, code, requestedBy });
}
function google(sub, address, userId = null, session = '') {
  return resolveGoogleUser({ sub, email: address, email_verified: true }, userId ? { user_id: userId, session_hash: session ? identityMerges.sessionHash(session) : null } : {});
}
async function account(kind) {
  const n = next();
  if (kind === 'email') return email(`matrix-${n}@example.invalid`);
  if (kind === 'google') return google(`google-${n}`, `google-${n}@example.invalid`);
  if (kind === 'vk') return users.upsertVkUser(n);
  return users.upsertTelegramUser({ id: n, first_name: 'Fixture' });
}
function snapshot(ids) {
  return ids.map(id => ({ user: users.getUserById(id), identities: identityRows(id),
    entries: owner('entries', id), contracts: owner('weekly_contracts', id),
    reminders: owner('reminders', id), artifacts: owner('user_artifacts', id),
    support: owner('user_support_actions', id) }));
}
function httpMerge(route, user, proof) {
  const handler = router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.data = value; return this; } };
  handler({ user, locale: 'en', body: { mergeToken: proof }, get: () => '' }, res);
  return res;
}
function fillHistory(user, label) {
  const entry = createEntry(user.id, 'joy', label);
  const d = db();
  d.prepare('UPDATE entries SET entry_date = ? WHERE id = ?').run(label === 'current' ? '2025-01-10' : '2025-01-11', entry.id);
  d.prepare(`INSERT INTO weekly_contracts (user_id,title,target_value,week_start,week_end,status)
    VALUES (?, ?, 'one', '2025-01-06', '2025-01-12', 'completed')`).run(user.id, label);
  d.prepare("INSERT INTO reminders (user_id,due_at,status,sent_at) VALUES (?, ?, 'sent', '2025-01-10')").run(user.id, `2025-01-${label === 'current' ? '10' : '11'}`);
  d.prepare('INSERT INTO user_artifacts (user_id,artifact_id) VALUES (?, ?)').run(user.id, `artifact-${label}`);
  const action = d.prepare('SELECT id FROM support_actions LIMIT 1').get();
  d.prepare("INSERT INTO user_support_actions (user_id,action_id,status) VALUES (?, ?, 'shown')").run(user.id, action.id);
}
function proofFor(offer) { return offer.mergeToken; }
after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const start of ['email', 'google', 'vk', 'telegram']) {
  for (const target of ['email', 'google', 'vk']) {
    if (start === target) continue;
    test(`${start} -> free ${target}: link on the same user and next login resolves it`, async () => {
      const current = await account(start);
      const n = next();
      const before = db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
      if (target === 'email') {
        const address = `free-${n}@example.invalid`;
        assert.equal((await email(address, current.id)).id, current.id);
        assert.equal((await email(address)).id, current.id);
      } else if (target === 'google') {
        const sub = `free-google-${n}`;
        assert.equal(google(sub, `free-google-${n}@example.invalid`, current.id).id, current.id);
        assert.equal(google(sub, `free-google-${n}@example.invalid`).id, current.id);
      } else {
        users.linkVkUser(current.id, n);
        assert.equal(users.upsertVkUser(n).id, current.id);
      }
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
      assert(users.getUserById(current.id));
    });
  }
  for (const target of ['email', 'google']) {
    if (start === target) continue;
    test(`${start} -> occupied ${target}: explicit link refuses with both users unchanged`, async () => {
      const current = await account(start), claimed = await account(target);
      const before = snapshot([current.id, claimed.id]);
      const subject = identityRows(claimed.id).find(x => x.provider === target).subject;
      if (target === 'email') await assert.rejects(email(subject, current.id), /другому аккаунту|another account/);
      else assert.throws(() => google(subject, 'occupied@example.invalid', current.id), /another account/);
      assert.deepEqual(snapshot([current.id, claimed.id]), before);
    });
  }
}

test('email -> verified Google Gmail and Google -> email OTP are one identity, not a destructive merge', async () => {
  const a = await email(`Gmail.${next()}+tag@googlemail.com`);
  createEntry(a.id, 'joy', 'gmail-first');
  const mailbox = identityRows(a.id)[0].subject;
  assert.equal(google(`gmail-${next()}`, mailbox).id, a.id);
  assert.equal((await email(mailbox)).id, a.id);
  const b = google(`gmail-${next()}`, `second.${next()}@gmail.com`);
  createEntry(b.id, 'joy', 'google-first');
  assert.equal((await email(identityRows(b.id).find(x => x.provider === 'email').subject)).id, b.id);
  assert.notEqual(a.id, b.id);
  assert.equal(owner('entries', a.id)[0].note, 'gmail-first');
  assert.equal(owner('entries', b.id)[0].note, 'google-first');
});

test('Telegram -> occupied VK with data: preview is non-mutating, confirmation retains histories and both logins', async () => {
  const current = await account('telegram'), source = await account('vk');
  fillHistory(current, 'current'); fillHistory(source, 'source');
  const offer = merges.buildVkMergeOffer(current.id, source.vk_id);
  assert.equal(offer.preview.canMerge, true);
  const before = snapshot([current.id, source.id]);
  assert.equal(httpMerge('/account/merge-vk/preview', current, proofFor(offer)).statusCode, 200);
  assert.deepEqual(snapshot([current.id, source.id]), before);
  const forged = httpMerge('/account/merge-vk/confirm', source, proofFor(offer));
  assert.equal(forged.statusCode, 400);
  assert.deepEqual(snapshot([current.id, source.id]), before);
  const done = httpMerge('/account/merge-vk/confirm', current, proofFor(offer));
  assert.equal(done.statusCode, 200);
  assert.equal(verifyToken(done.data.token), current.id);
  assert.equal(users.getUserById(source.id), undefined);
  for (const table of ['entries', 'weekly_contracts', 'reminders', 'user_artifacts']) assert.equal(owner(table, current.id).length, 2, table);
  assert.equal(owner('user_support_actions', current.id).length, 1);
  assert.equal(users.upsertVkUser(source.vk_id).id, current.id);
  assert.equal(users.upsertTelegramUser({ id: current.telegram_id }).id, current.id);
  assert.deepEqual(db().pragma('foreign_key_check'), []);
  assert.equal(httpMerge('/account/merge-vk/confirm', current, proofFor(offer)).statusCode, 400);
});

test('VK offer is bound to the initiating bearer; another session cannot confirm', async () => {
  const current = await account('telegram'), source = await account('vk');
  fillHistory(source, 'source');
  const session = createToken(current.id), otherSession = createToken(current.id, Date.now()-1000);
  const offer = merges.buildVkMergeOffer(current.id, source.vk_id, session);
  const before = snapshot([current.id, source.id]);
  assert.throws(() => merges.applyMergeByToken(offer.mergeToken, current.id, otherSession), /session mismatch/);
  assert.deepEqual(snapshot([current.id, source.id]), before);
  assert.equal(merges.applyMergeByToken(offer.mergeToken, current.id, session).user.id, current.id);
});

test('email/Google -> occupied VK+Telegram: explicit reverse merge retains both logins and records', async () => {
  for (const start of ['email', 'google']) {
    const current = await account(start), survivor = await account('telegram');
    const vkId = next(); users.linkVkUser(survivor.id, vkId);
    fillHistory(current, 'source'); fillHistory(survivor, 'current');
    const before = snapshot([current.id, survivor.id]);
    const offer = merges.buildVkMergeOffer(current.id, vkId);
    assert.equal(offer.preview.result.transferLogins, true);
    assert.equal(offer.preview.canMerge, true);
    assert.equal(offer.preview.primary.id, survivor.id);
    assert.equal(httpMerge('/account/merge-vk/preview', current, proofFor(offer)).statusCode, 200);
    assert.deepEqual(snapshot([current.id, survivor.id]), before);
    assert.equal(httpMerge('/account/merge-vk/confirm', survivor, proofFor(offer)).statusCode, 400);
    assert.deepEqual(snapshot([current.id, survivor.id]), before);
    const result = httpMerge('/account/merge-vk/confirm', current, proofFor(offer));
    assert.equal(result.statusCode, 200);
    assert.equal(verifyToken(result.data.token), survivor.id);
    assert.equal(users.getUserById(current.id), undefined);
    for (const table of ['entries', 'weekly_contracts', 'reminders', 'user_artifacts']) assert.equal(owner(table, survivor.id).length, 2, `${start} ${table}`);
    assert.equal(owner('user_support_actions', survivor.id).length, 1);
    assert.deepEqual(identityRows(survivor.id).map(x => x.provider), [start]);
    assert.equal(users.upsertVkUser(vkId).id, survivor.id);
    assert.equal(users.upsertTelegramUser({ id: survivor.telegram_id }).id, survivor.id);
    const login = identityRows(survivor.id)[0];
    if (start === 'email') assert.equal((await email(login.subject)).id, survivor.id);
    else assert.equal(google(login.subject, `google-${login.subject.slice(7)}@example.invalid`).id, survivor.id);
    assert.deepEqual(db().pragma('foreign_key_check'), []);
  }
});

test('reverse VK merge refuses enabled reminder settings that would be lost', async () => {
  for (const survivorEnabled of [false, true]) {
    const current = await account(survivorEnabled ? 'google' : 'email'), survivor = await account('telegram');
    const vkId = next(); users.linkVkUser(survivor.id, vkId);
    db().prepare('UPDATE users SET reminders_enabled = 1, timezone = ?, evening_reminder_time = ? WHERE id = ?')
      .run('Europe/Moscow', '09:00', current.id);
    db().prepare('UPDATE users SET reminders_enabled = ?, timezone = ?, evening_reminder_time = ? WHERE id = ?')
      .run(Number(survivorEnabled), 'UTC', '20:00', survivor.id);
    const before = snapshot([current.id, survivor.id]);
    const session = createToken(current.id);
    const offer = merges.buildVkMergeOffer(current.id, vkId, session);
    assert.equal(offer.preview.canMerge, false);
    assert(offer.preview.blocking.includes('settings_conflict'));
    const refused = route('post', '/account/merge-vk/confirm', current, session, { mergeToken: offer.mergeToken });
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(snapshot([current.id, survivor.id]), before);
    assert.deepEqual(db().pragma('foreign_key_check'), []);
  }
});

test('reverse VK merge rechecks reminder conflict at confirmation after a clean preview', async () => {
  const current = await account('email'), survivor = await account('telegram');
  const vkId = next(); users.linkVkUser(survivor.id, vkId);
  const session = createToken(current.id);
  const offer = merges.buildVkMergeOffer(current.id, vkId, session);
  assert.equal(offer.preview.canMerge, true);
  db().prepare('UPDATE users SET reminders_enabled = 1, evening_reminder_time = ? WHERE id = ?').run('09:00', current.id);
  const before = snapshot([current.id, survivor.id]);
  const refused = route('post', '/account/merge-vk/confirm', current, session, { mergeToken: offer.mergeToken });
  assert.equal(refused.statusCode, 409);
  assert(refused.data.preview.blocking.includes('settings_conflict'));
  assert.deepEqual(snapshot([current.id, survivor.id]), before);
});

test('occupied VK directions that cannot safely merge refuse without deleting an identity', async () => {
  for (const start of ['email', 'google', 'vk', 'telegram']) {
    const current = await account(start), source = await account('vk');
    fillHistory(source, 'source');
    const before = snapshot([current.id, source.id]);
    const offer = merges.buildVkMergeOffer(current.id, source.vk_id);
    assert.equal(offer.mergeRequired, true);
    if (start === 'vk') {
      assert(offer.preview.blocking.includes('primary_vk_conflict'));
      assert.equal(offer.preview.canMerge, false);
      assert.equal(httpMerge('/account/merge-vk/confirm', current, proofFor(offer)).statusCode, 409);
    } else {
      assert.equal(offer.preview.canMerge, true);
      assert.throws(() => users.linkVkUser(current.id, source.vk_id));
    }
    assert.deepEqual(snapshot([current.id, source.id]), before);
  }
});

test('expired/tampered/wrong-session proof and identity collision leave both accounts intact', async () => {
  const current = await account('telegram'), source = await account('vk');
  fillHistory(source, 'source');
  const valid = merges.buildVkMergeOffer(current.id, source.vk_id).mergeToken;
  const expired = createMergeToken({ primaryUserId: current.id, sourceUserId: source.id, vkId: source.vk_id }, Date.now() - 31 * 60 * 1000);
  const before = snapshot([current.id, source.id]);
  for (const proof of [expired, valid + 'x', '', valid.split('.')[0] + '.invalid']) {
    assert.equal(httpMerge('/account/merge-vk/confirm', current, proof).statusCode, 400);
    assert.deepEqual(snapshot([current.id, source.id]), before);
  }
  assert.equal(httpMerge('/account/merge-vk/preview', source, valid).statusCode, 403);
  // A VK source with an extra login identity must not be destroyed by forward merge.
  db().prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email',?,?)").run(`conflict-${next()}@example.invalid`, source.id);
  const conflict = snapshot([current.id, source.id]);
  assert.equal(httpMerge('/account/merge-vk/confirm', current, valid).statusCode, 409);
  assert.deepEqual(snapshot([current.id, source.id]), conflict);
});

test('Telegram identity is never linked by an unproved ID', async () => {
  for (const start of ['email', 'google', 'vk']) {
    const current = await account(start), telegram = await account('telegram');
    fillHistory(current, 'current'); fillHistory(telegram, 'source');
    const before = snapshot([current.id, telegram.id]);
    assert.equal(users.upsertTelegramUser({ id: telegram.telegram_id, first_name: 'Fixture' }).id, telegram.id);
    assert.deepEqual(snapshot([current.id, telegram.id]), before);
  }
});

function route(method, path, user, session, body = {}) {
  const layer = router.stack.find(layer => layer.route?.path === path && layer.route?.methods[method]);
  assert(layer, `${method} ${path}`);
  const handler = layer.route.stack.at(-1).handle;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, set() { return this; }, json(data) { this.data = data; return this; } };
  handler({ user, body, get: () => `Bearer ${session}`, ip: '127.0.0.1' }, res);
  return res;
}
function telegramProof(id, startParam = '') {
  const payload = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id, first_name: 'Fixture' }) });
  if (startParam) payload.set('start_param', startParam);
  const check = [...payload].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('fixture-bot-key').digest();
  payload.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return payload.toString();
}
for (const start of ['email', 'google', 'vk']) {
  test(`${start} -> Telegram Mini App handoff is proof-bound, session-bound, one-use and returns to initiating session`, async () => {
    const current = await account(start), source = await account('telegram');
    fillHistory(current, 'current'); fillHistory(source, 'source');
    const secondAction = db().prepare('SELECT id FROM support_actions ORDER BY id LIMIT 1 OFFSET 1').get();
    db().prepare('UPDATE user_support_actions SET action_id = ? WHERE user_id = ?').run(secondAction.id, source.id);
    const session = createToken(current.id), wrong = createToken(current.id, Date.now() - 1000);
    const created = route('post', '/settings/telegram-link-intent', current, session);
    assert.equal(created.statusCode, 200);
    const intent = created.data.intent, startParam = `link_${intent}`;
    assert.equal(created.data.launchUrl, `https://t.me/fixture_bot?startapp=${startParam}`);
    const before = snapshot([current.id, source.id]);
    assert.equal(route('post', '/settings/telegram-link-complete', current, session, { intent }).data.pending, true);
    assert.equal(route('post', '/auth/telegram-link-claim', null, '', { initData: telegramProof(source.telegram_id) }).statusCode, 400);
    assert.equal(route('post', '/auth/telegram-link-claim', null, '', { initData: telegramProof(source.telegram_id, startParam).replace(/hash=[^&]+/, 'hash=invalid') }).statusCode, 400);
    const proof = telegramProof(source.telegram_id, startParam);
    assert.equal(route('post', '/auth/telegram-link-claim', null, '', { initData: proof }).statusCode, 200);
    assert.deepEqual(snapshot([current.id, source.id]), before);
    assert.equal(route('post', '/auth/telegram-link-claim', null, '', { initData: proof }).statusCode, 400);
    assert.equal(route('post', '/settings/telegram-link-complete', current, wrong, { intent }).statusCode, 400);
    assert.equal(route('post', '/settings/telegram-link-complete', source, session, { intent }).statusCode, 400);
    const offer = route('post', '/settings/telegram-link-complete', current, session, { intent });
    assert.equal(offer.statusCode, 409);
    assert.deepEqual(snapshot([current.id, source.id]), before);
    assert.equal(route('post', '/settings/telegram-link-complete', current, session, { intent }).statusCode, 400);
    assert.equal(route('post', '/account/merge-identity/preview', current, session, { mergeToken: offer.data.mergeToken }).statusCode, 200);
    const merged = route('post', '/account/merge-identity/confirm', current, session, { mergeToken: offer.data.mergeToken, confirm: true });
    assert.equal(merged.statusCode, 200, JSON.stringify(merged.data));
    assert.equal(verifyToken(merged.data.token), source.id);
    assert.equal(owner('entries', source.id).length, 2);
  });
}
for (const start of ['email', 'google', 'vk']) {
  test(`${start} -> free Telegram: signed Mini App proof links once and next login resolves`, async () => {
    const current = await account(start), session = createToken(current.id), id = next();
    const forged = telegramProof(id).replace(/hash=[^&]+/, 'hash=invalid');
    assert.equal(route('post', '/settings/link-telegram', current, session, { initData: forged }).statusCode, 400);
    assert.equal(users.getUserById(current.id).telegram_id.startsWith(start + ':'), true);
    const proof = telegramProof(id);
    const linked = route('post', '/settings/link-telegram', current, session, { initData: proof });
    assert.equal(linked.statusCode, 200);
    assert.equal(linked.data.user.telegramLinked, true);
    assert.equal(users.upsertTelegramUser({ id }).id, current.id);
    assert.equal(route('post', '/settings/link-telegram', current, session, { initData: proof }).statusCode, 400);
  });
}
test('occupied identity with record collision blocks and rolls back; session and provider changes invalidate offer', async () => {
  const current = await account('vk'), other = await account('google'), session = createToken(current.id);
  const subject = identityRows(other.id).find(row => row.provider === 'google').subject;
  const offer = google(subject, 'collide@example.invalid', current.id, session).mergeOffer;
  fillHistory(current, 'current'); fillHistory(other, 'current');
  db().prepare("UPDATE reminders SET status = 'scheduled', sent_at = NULL WHERE user_id = ?").run(other.id);
  const before = snapshot([current.id, other.id]);
  const blocked = route('post', '/account/merge-identity/confirm', current, session, { mergeToken: offer.mergeToken, confirm: true });
  assert.equal(blocked.statusCode, 409);
  assert(blocked.data.preview.blocking.includes('reminder_conflict'));
  assert.deepEqual(snapshot([current.id, other.id]), before);
  assert(identityMerges.readOffer(offer.mergeToken, session, current.id));
  db().prepare('UPDATE login_identities SET subject = ? WHERE provider = ? AND subject = ?').run('moved-google', 'google', subject);
  assert.equal(route('post', '/account/merge-identity/preview', current, session, { mergeToken: offer.mergeToken }).statusCode, 403);
});
test('mid-transaction SQLite abort preserves every record, offer, login and referral code', async () => {
  const current = await account('telegram'), other = await account('email'), session = createToken(current.id);
  const subject = identityRows(other.id)[0].subject;
  fillHistory(current, 'current'); fillHistory(other, 'source');
  const secondAction = db().prepare('SELECT id FROM support_actions ORDER BY id LIMIT 1 OFFSET 1').get();
  db().prepare('UPDATE user_support_actions SET action_id = ? WHERE user_id = ?').run(secondAction.id, other.id);
  const referred = await account('vk');
  db().prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(other.id, referred.id);
  const oldCode = users.ensureRefCode(other.id);
  const offer = identityMerges.createOffer({ currentId: current.id, provider: 'email', subject, session });
  const before = snapshot([current.id, other.id]);
  db().exec(`CREATE TRIGGER abort_merge BEFORE DELETE ON users WHEN OLD.id = ${other.id} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  assert.throws(() => identityMerges.confirmOffer(offer.mergeToken, session, current.id), /fixture failure/);
  assert.deepEqual(snapshot([current.id, other.id]), before);
  assert.equal(users.getUserById(referred.id).referrer_id, other.id);
  assert(identityMerges.readOffer(offer.mergeToken, session, current.id));
  db().exec('DROP TRIGGER abort_merge');
  const result = identityMerges.confirmOffer(offer.mergeToken, session, current.id);
  assert.equal(result.user.id, current.id);
  assert.equal(users.resolveRefCode(oldCode).id, current.id);
  assert.equal(users.getUserById(referred.id).referrer_id, current.id);
  assert.equal(owner('user_support_actions', current.id).length, 2);
  assert.deepEqual(db().pragma('foreign_key_check'), []);
});
for (const start of ['email', 'google', 'vk', 'telegram']) for (const target of ['email', 'google', 'telegram']) {
  if (start === target) continue;
  test(`${start} -> occupied ${target}: verified proof, unchanged preview, explicit atomic merge and relogin`, async () => {
    const current = await account(start), source = await account(target);
    fillHistory(current, 'current'); fillHistory(source, 'source');
    const secondAction = db().prepare('SELECT id FROM support_actions ORDER BY id LIMIT 1 OFFSET 1').get();
    assert(secondAction);
    db().prepare('UPDATE user_support_actions SET action_id = ? WHERE user_id = ?').run(secondAction.id, source.id);
    const session = createToken(current.id), wrongSession = createToken(current.id, Date.now()-1000);
    const before = snapshot([current.id, source.id]);
    let offer;
    if (target === 'email') {
      const subject = identityRows(source.id).find(row => row.provider === 'email').subject;
      // OTP challenge is bound to the exact current bearer before provider proof.
      let code;
      db().prepare('UPDATE email_login_codes SET sent_at = sent_at - 61 WHERE email = ?').run(subject);
      await requestEmailCode({ email: subject, requestedBy: current.id, session, sender: async (_, value) => { code = value; } });
      assert.throws(() => verifyEmailCode({ email: subject, code, requestedBy: current.id, session: wrongSession }));
      offer = verifyEmailCode({ email: subject, code, requestedBy: current.id, session }).mergeOffer;
    } else if (target === 'google') {
      const subject = identityRows(source.id).find(row => row.provider === 'google').subject;
      offer = google(subject, `occupied-${next()}@example.invalid`, current.id, session).mergeOffer;
    } else {
      const proof = telegramProof(source.telegram_id);
      const response = route('post', '/settings/link-telegram', current, session, { initData: proof });
      assert.equal(response.statusCode, 409);
      offer = response.data;
      assert.equal(route('post', '/settings/link-telegram', current, session, { initData: proof }).statusCode, 400, 'provider proof replay');
    }
    assert.equal(offer.mergeRequired, true);
    assert.deepEqual(snapshot([current.id, source.id]), before);
    assert.equal(route('post', '/account/merge-identity/preview', current, wrongSession, { mergeToken: offer.mergeToken }).statusCode, 403);
    const preview = route('post', '/account/merge-identity/preview', current, session, { mergeToken: offer.mergeToken });
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(snapshot([current.id, source.id]), before);
    assert.equal(route('post', '/account/merge-identity/confirm', current, session, { mergeToken: offer.mergeToken }).statusCode, 400);
    assert.equal(route('post', '/account/merge-identity/confirm', source, session, { mergeToken: offer.mergeToken, confirm: true }).statusCode, 400);
    assert.deepEqual(snapshot([current.id, source.id]), before);
    const confirmed = route('post', '/account/merge-identity/confirm', current, session, { mergeToken: offer.mergeToken, confirm: true });
    assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.data));
    const survivor = confirmed.data.user.id;
    assert.equal(verifyToken(confirmed.data.token), survivor);
    assert.equal(owner('entries', survivor).length, 2);
    assert.equal(owner('weekly_contracts', survivor).length, 2);
    assert.equal(owner('reminders', survivor).length, 2);
    assert.equal(owner('user_artifacts', survivor).length, 2);
    assert.equal(owner('user_support_actions', survivor).length, 2);
    assert.deepEqual(db().pragma('foreign_key_check'), []);
    assert.equal(route('post', '/account/merge-identity/confirm', users.getUserById(survivor), session, { mergeToken: offer.mergeToken, confirm: true }).statusCode, 400);
    assert.equal(users.getUserById(current.id)?.id || users.getUserById(source.id)?.id, survivor);
    for (const identity of identityRows(survivor)) {
      if (identity.provider === 'email') assert.equal((await email(identity.subject)).id, survivor);
      else assert.equal(google(identity.subject, 'login@example.invalid').id, survivor);
    }
    const survivorRow = users.getUserById(survivor);
    if (/^\d+$/.test(survivorRow.telegram_id)) assert.equal(users.upsertTelegramUser({ id: survivorRow.telegram_id }).id, survivor);
    if (survivorRow.vk_id) assert.equal(users.upsertVkUser(survivorRow.vk_id).id, survivor);
  });
}
