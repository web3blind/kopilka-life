const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-merge-safety-'));
const configPath = require.resolve('../src/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
  nodeEnv: 'test', isProduction: false, schedulerEnabled: false, dbPath: path.join(dir, 'isolated.sqlite'),
  sessionSecret: 'merge-safety-fixture', sessionMaxAgeSeconds: 600, webappUrl: 'https://fixture.invalid',
  rateLimits: { storyWindowMs: 60000, storyMax: 100, authWindowMs: 60000, authMax: 100, devWindowMs: 60000, devMax: 100 }
} };
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/usersService');
const { createEntry, getSummary } = require('../src/services/entriesService');
const { createToken, verifyToken, inspectToken } = require('../src/auth/session');
const { createMergeToken } = require('../src/auth/mergeToken');
const vkMerge = require('../src/services/accountMergeService');
const identityMerge = require('../src/services/identityMergeService');
const { publicProfileByCode, grantReferrerBonusOnFirstEntry } = require('../src/services/referralService');
const router = require('../src/routes/api');
let seq = 910000;
const tg = () => users.upsertTelegramUser({ id: ++seq, first_name: `Person${seq}` });
const vk = () => users.upsertVkUser(++seq);
const db = () => getDb();
const rows = (table, id) => db().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(id);
function seedPush(userId) {
  return Number(db().prepare(`INSERT INTO push_subscriptions(user_id,endpoint_hash,endpoint,p256dh,auth,session_revision)
    VALUES (?,?,?,?,?,(SELECT session_revision FROM users WHERE id=?))`)
    .run(userId, `fixture-${userId}`, `https://fcm.googleapis.com/fcm/send/fixture-${userId}`, 'fixture-key', 'fixture-auth', userId).lastInsertRowid);
}
function seed(primary, source) {
  for (const user of [primary, source]) seedPush(user.id);
  const a = createEntry(primary.id, 'joy', 'primary private note');
  const b = createEntry(source.id, 'joy', 'source private note');
  for (const id of [primary.id, source.id]) {
    db().prepare("INSERT INTO reminders (user_id, due_at, status) VALUES (?, '2030-01-01', 'scheduled')").run(id);
    db().prepare("INSERT INTO user_artifacts (user_id, artifact_id) VALUES (?, 'shared')").run(id);
    db().prepare("INSERT INTO user_support_actions (user_id, action_id, status, metadata_json) VALUES (?, (SELECT id FROM support_actions LIMIT 1), 'shown', '{\"same\":true}')").run(id);
  }
  db().prepare("INSERT INTO reminders (user_id, due_at, status) VALUES (?, '2030-01-02', 'scheduled')").run(source.id);
  db().prepare("UPDATE users SET referrer_bonus_granted = 1 WHERE id = ?").run(source.id);
  return { a, b };
}
function assertMerged(primary, source, before, aliases) {
  assert.equal(rows('push_subscriptions', primary.id).length, 0, 'survivor browser must opt in again');
  assert.equal(rows('push_subscriptions', source.id).length, 0, 'retired browser must never be transferred');
  assert.equal(users.getUserById(source.id), undefined);
  assert.equal(getSummary(primary.id).totalLife, before);
  assert.equal(rows('entries', primary.id).length, 2);
  assert.deepEqual(rows('entries', primary.id).map(x => x.note).sort(), ['primary private note', 'source private note'].sort());
  assert.equal(rows('reminders', primary.id).length, 2);
  assert.equal(rows('reminders', primary.id).filter(x => x.status === 'scheduled').length, 2);
  assert.equal(rows('user_artifacts', primary.id).length, 1);
  assert.equal(rows('user_support_actions', primary.id).length, 1);
  assert.equal(users.getUserById(primary.id).referrer_bonus_granted, 1);
  assert.equal(grantReferrerBonusOnFirstEntry(primary.id), false);
  for (const code of aliases) {
    assert.equal(users.resolveRefCode(code).id, primary.id);
    assert.equal(publicProfileByCode(code).refCode, users.getUserById(primary.id).ref_code);
    const invited = users.upsertTelegramUser({ id: ++seq }, code);
    assert.equal(invited.referrer_id, primary.id);
  }
  assert.deepEqual(db().pragma('foreign_key_check'), []);
}
async function server() {
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api', router);
  return new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function api(s, route, token, body) {
  const response = await fetch(`http://127.0.0.1:${s.address().port}/api${route}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}
after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('VK merge retains same-day entries, unsent reminders, aliases and credit; revokes both users sessions', async () => {
  const s = await server();
  try {
    const primary = tg(), source = vk(), outsider = tg();
    const aliases = [source.ref_code];
    const { a } = seed(primary, source);
    const before = getSummary(primary.id).totalLife + getSummary(source.id).totalLife;
    seedPush(outsider.id);
    const outsiderPush = rows('push_subscriptions', outsider.id);
    const oldPrimary = createToken(primary.id), oldSource = createToken(source.id), other = createToken(outsider.id);
    const proof = createMergeToken({ primaryUserId: primary.id, sourceUserId: source.id, vkId: source.vk_id,
      authenticatedUserId: primary.id, sessionHash: require('node:crypto').createHash('sha256').update(oldPrimary).digest('hex') });
    assert.equal(vkMerge.buildMergePreview(primary.id, source.id).canMerge, true);
    const confirmed = await api(s, '/account/merge-vk/confirm', oldPrimary, { mergeToken: proof });
    assert.equal(confirmed.status, 200);
    assertMerged(primary, source, before, aliases);
    assert.equal(rows('entries', primary.id).find(x => x.id === a.id).life_points, 1);
    for (const token of [oldPrimary, oldSource]) {
      assert.equal(verifyToken(token), null);
      assert.equal((await api(s, '/me', token)).status, 401);
    }
    assert.equal((await api(s, '/me', confirmed.data.token)).status, 200);
    assert.equal((await api(s, '/me', other)).status, 200);
    assert.deepEqual(rows('push_subscriptions', outsider.id), outsiderPush, 'unrelated browser subscription preserved');
  } finally { await new Promise(resolve => s.close(resolve)); }
});

test('identity merge retains records and aliases; revokes source and survivor sessions', async () => {
  const s = await server();
  try {
    const primary = tg(), source = vk(), outsider = tg();
    db().prepare("INSERT INTO login_identities(provider,subject,user_id) VALUES ('email',?,?)").run(`merge-${++seq}@invalid.test`, source.id);
    const { a } = seed(primary, source);
    const alias = source.ref_code, before = getSummary(primary.id).totalLife + getSummary(source.id).totalLife;
    seedPush(outsider.id);
    const outsiderPush = rows('push_subscriptions', outsider.id);
    const oldPrimary = createToken(primary.id), oldSource = createToken(source.id), other = createToken(outsider.id);
    const offer = identityMerge.createOffer({ currentId: primary.id, provider: 'email', subject: db().prepare("SELECT subject FROM login_identities WHERE user_id = ?").get(source.id).subject, session: oldPrimary });
    assert.equal(offer.preview.canMerge, true);
    const confirmed = await api(s, '/account/merge-identity/confirm', oldPrimary, { mergeToken: offer.mergeToken, confirm: true });
    assert.equal(confirmed.status, 200);
    assertMerged(primary, source, before, [alias]);
    assert.equal(rows('entries', primary.id).find(x => x.id === a.id).life_points, 1);
    for (const token of [oldPrimary, oldSource]) {
      assert.equal(verifyToken(token), null);
      assert.equal((await api(s, '/me', token)).status, 401);
    }
    assert.equal((await api(s, '/me', confirmed.data.token)).status, 200);
    assert.equal((await api(s, '/me', other)).status, 200);
    assert.deepEqual(rows('push_subscriptions', outsider.id), outsiderPush, 'unrelated browser subscription preserved');
  } finally { await new Promise(resolve => s.close(resolve)); }
});

test('legacy signed token without revision remains valid before merge, invalid after; unrelated remains valid', async () => {
  const crypto = require('node:crypto');
  const config = require('../src/config');
  const legacy = user => {
    const payload = Buffer.from(JSON.stringify({ v: 1, userId: user.id, iat: Date.now(), exp: Date.now() + 600000 })).toString('base64url');
    return `${payload}.${crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')}`;
  };
  const primary = tg(), source = vk(), outsider = tg();
  createEntry(source.id, 'joy');
  const p = legacy(primary), v = legacy(source), o = legacy(outsider);
  assert.equal(inspectToken(p).status, 'valid');
  assert.equal(verifyToken(p), primary.id);
  assert.equal(verifyToken(v), source.id);
  const result = vkMerge.applyMergeByToken(createMergeToken({ primaryUserId: primary.id, sourceUserId: source.id, vkId: source.vk_id, authenticatedUserId: primary.id }), primary.id);
  assert.equal(verifyToken(p), null);
  assert.equal(verifyToken(v), null);
  assert.equal(verifyToken(o), outsider.id);
  assert.equal(verifyToken(createToken(result.user.id)), primary.id);
});

test('reverse VK merge retains retiring synthetic referral links and invalidates both sessions', () => {
  const primary = vk();
  db().prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(String(++seq), primary.id);
  const source = tg();
  db().prepare("UPDATE users SET telegram_id = ? WHERE id = ?").run(`email:${source.id}`, source.id);
  db().prepare("INSERT INTO login_identities(provider,subject,user_id) VALUES ('email',?,?)").run(`reverse-${++seq}@invalid.test`, source.id);
  const alias = source.ref_code;
  seed(primary, source);
  const before = getSummary(primary.id).totalLife + getSummary(source.id).totalLife;
  const first = createToken(primary.id), second = createToken(source.id);
  const offer = vkMerge.buildVkMergeOffer(source.id, primary.vk_id, second);
  assert(offer.preview.canMerge);
  const result = vkMerge.applyMergeByToken(offer.mergeToken, source.id, second);
  assert.equal(result.user.id, primary.id);
  assertMerged(primary, source, before, [alias]);
  assert.equal(verifyToken(first), null);
  assert.equal(verifyToken(second), null);
  assert.equal(verifyToken(createToken(primary.id)), primary.id);
});

test('push subscription cleanup rolls back if either merge transaction fails after cleanup', () => {
  for (const kind of ['vk', 'identity']) {
    const primary = tg(), source = vk();
    seed(primary, source);
    const session = createToken(primary.id);
    let perform;
    if (kind === 'vk') {
      const token = createMergeToken({ primaryUserId: primary.id, sourceUserId: source.id, vkId: source.vk_id, authenticatedUserId: primary.id });
      perform = () => vkMerge.applyMergeByToken(token, primary.id);
    } else {
      const subject = `rollback-${++seq}@invalid.test`;
      db().prepare("INSERT INTO login_identities(provider,subject,user_id) VALUES ('email',?,?)").run(subject, source.id);
      const offer = identityMerge.createOffer({ currentId: primary.id, provider: 'email', subject, session });
      perform = () => identityMerge.confirmOffer(offer.mergeToken, session, primary.id);
    }
    const subscriptions = db().prepare('SELECT * FROM push_subscriptions ORDER BY id').all();
    const entries = db().prepare('SELECT * FROM entries ORDER BY id').all();
    db().exec(`CREATE TEMP TRIGGER abort_push_merge BEFORE UPDATE OF user_id ON entries
      WHEN OLD.user_id = ${source.id} BEGIN SELECT RAISE(ABORT, 'fixture forced rollback'); END`);
    try { assert.throws(perform, /fixture forced rollback/); }
    finally { db().exec('DROP TRIGGER abort_push_merge'); }
    assert.deepEqual(db().prepare('SELECT * FROM push_subscriptions ORDER BY id').all(), subscriptions);
    assert.deepEqual(db().prepare('SELECT * FROM entries ORDER BY id').all(), entries);
    assert.equal(verifyToken(session), primary.id);
    assert(users.getUserById(source.id));
  }
});

test('both engines block unequal reminder states and opaque support metadata without any partial writes', () => {
  for (const kind of ['vk', 'identity']) {
    const primary = tg(), source = vk();
    if (kind === 'identity') db().prepare("INSERT INTO login_identities(provider,subject,user_id) VALUES ('email',?,?)").run(`block-${++seq}@invalid.test`, source.id);
    db().prepare("INSERT INTO reminders(user_id,due_at,status) VALUES (?, '2032-01-01', 'scheduled')").run(primary.id);
    db().prepare("INSERT INTO reminders(user_id,due_at,status,sent_at) VALUES (?, '2032-01-01', 'sent', '2032-01-01')").run(source.id);
    const action = db().prepare('SELECT id FROM support_actions LIMIT 1').get().id;
    db().prepare("INSERT INTO user_support_actions(user_id,action_id,metadata_json) VALUES (?,?,?)").run(primary.id, action, '{"a":1}');
    db().prepare("INSERT INTO user_support_actions(user_id,action_id,metadata_json) VALUES (?,?,?)").run(source.id, action, '{"a":2}');
    const preview = kind === 'vk' ? vkMerge.buildMergePreview(primary.id, source.id) : identityMerge.preview(db(), primary.id, source.id);
    assert(preview.blocking.includes('reminder_conflict'));
    assert(preview.blocking.includes('support_metadata_conflict'));
    const subscriptions = [seedPush(primary.id), seedPush(source.id)];
    const snapshot = db().prepare('SELECT * FROM reminders WHERE user_id IN (?,?) ORDER BY id').all(primary.id, source.id);
    if (kind === 'vk') assert.throws(() => vkMerge.applyMergeByToken(createMergeToken({ primaryUserId: primary.id, sourceUserId: source.id, vkId: source.vk_id, authenticatedUserId: primary.id }), primary.id), /merge blocked/);
    else {
      const session = createToken(primary.id);
      const offer = identityMerge.createOffer({ currentId: primary.id, provider: 'email', subject: db().prepare("SELECT subject FROM login_identities WHERE user_id = ?").get(source.id).subject, session });
      assert.throws(() => identityMerge.confirmOffer(offer.mergeToken, session, primary.id), /Merge blocked/);
    }
    assert.deepEqual(db().prepare('SELECT * FROM reminders WHERE user_id IN (?,?) ORDER BY id').all(primary.id, source.id), snapshot);
    assert.deepEqual(db().prepare('SELECT id FROM push_subscriptions WHERE user_id IN (?,?) ORDER BY id').all(primary.id, source.id).map(row => row.id), subscriptions);
    assert(users.getUserById(source.id));
  }
});
