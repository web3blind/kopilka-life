const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

// Real migrations/services/router, isolated SQLite; never load dotenv or a scheduler.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-account-'));
const configPath = require.resolve('../src/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
  nodeEnv: 'test', isProduction: false, schedulerEnabled: false,
  dbPath: path.join(tempDir, 'test.sqlite'), sessionSecret: 'account-fixture-only',
  sessionMaxAgeSeconds: 600, vkGroupToken: '', botToken: '',
  rateLimits: { storyWindowMs: 60000, storyMax: 100, authWindowMs: 60000, authMax: 100, devWindowMs: 60000, devMax: 100 }
} };
const originalFetch = global.fetch;
global.fetch = async () => { throw new Error('Network forbidden in account tests'); };
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/usersService');
const entries = require('../src/services/entriesService');
const merges = require('../src/services/accountMergeService');
const { createMergeToken } = require('../src/auth/mergeToken');
const { badgeForUser, openSupportAction } = require('../src/services/supportActionsService');
const router = require('../src/routes/api');
let identity = 10000;
const tg = () => users.upsertTelegramUser({ id: ++identity, first_name: 'Telegram', language_code: 'en' });
const vk = () => users.upsertVkUser(++identity, null, 'UTC', 'en', 'VK');
const pair = () => ({ primary: tg(), source: vk() });
const token = (p, s) => createMergeToken({ primaryUserId: p.id, sourceUserId: s.id, vkId: s.vk_id });
const merge = (p, s) => merges.applyMergeByToken(token(p, s), p.id);
const row = (table, id) => getDb().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(id);
function invoke(routePath, user, body = {}, params = {}) {
  // Invoke the real API handler with an authenticated fixture user (no sockets).
  const route = router.stack.find((layer) => layer.route?.path === routePath).route;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  route.stack.at(-1).handle({ user, locale: 'en', body, params, query: {} }, res);
  return res;
}
after(() => { global.fetch = originalFetch; closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

test('both repeated platform upserts preserve manually chosen locale and refresh names', () => {
  for (const make of [tg, vk]) {
    const user = make();
    assert.equal(user.locale, 'en');
    users.updateLocale(user.id, 'ru');
    const updated = user.vk_id
      ? users.upsertVkUser(user.vk_id, null, 'UTC', 'en', 'Updated VK')
      : users.upsertTelegramUser({ id: user.telegram_id, first_name: 'Updated Telegram', language_code: 'en' });
    assert.equal(updated.locale, 'ru');
    assert.match(updated.first_name, /^Updated/);
    assert.equal(updated.ref_code, user.ref_code);
  }
});

test('two full notes survive merge, API reads/edits, explicit oversized rejection, no extra points', () => {
  const { primary, source } = pair();
  const a = entries.createEntry(primary.id, 'joy', 'А'.repeat(2000));
  const b = entries.createEntry(source.id, 'joy', 'Б'.repeat(2000));
  const expected = `${a.note}\n\nИз слитого аккаунта: ${b.note}`;
  const res = invoke('/account/merge-vk/confirm', primary, { mergeToken: token(primary, source) });
  assert.equal(res.statusCode, 200);
  assert.equal(row('entries', primary.id)[0].note, expected);
  assert.equal(entries.getSummary(primary.id).totalLife, entries.ENTRY_POINTS.joy);
  assert.equal(entries.getHistory(primary.id).selectedEntries[0].note, expected);
  const edit = expected.replace('А', 'В');
  const saved = invoke('/entries/:id', primary, { note: edit }, { id: a.id });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.data.entry.note, edit);
  const rejected = invoke('/entries/:id', primary, { note: edit + 'X' }, { id: a.id });
  assert.equal(rejected.statusCode, 400);
  assert(rejected.data.error);
  assert.equal(row('entries', primary.id)[0].note, edit);
  assert.throws(() => entries.createEntry(primary.id, 'rest', 'X'.repeat(2001)), /entryNoteTooLong/);
  assert.equal(users.getUserById(source.id), undefined);
});

test('identical and empty duplicate notes preserve content without repeat labels', () => {
  for (const [left, right] of [['same', 'same'], ['', 'source'], ['target', '']]) {
    const { primary, source } = pair();
    entries.createEntry(primary.id, 'joy', left);
    entries.createEntry(source.id, 'joy', right);
    merge(primary, source);
    assert.equal(row('entries', primary.id)[0].note, !left && right ? `Из слитого аккаунта: ${right}` : left);
  }
});

test('artifacts transfer and deduplicate with earliest award and remapped triggering entry', () => {
  const db = getDb();
  const { primary, source } = pair();
  const a = entries.createEntry(primary.id, 'joy');
  const b = entries.createEntry(source.id, 'joy');
  db.prepare('INSERT INTO user_artifacts VALUES (?, ?, ?, ?)').run(primary.id, 'shared', a.id, '2026-02-01');
  db.prepare('INSERT INTO user_artifacts VALUES (?, ?, ?, ?)').run(source.id, 'shared', b.id, '2026-01-01');
  db.prepare('INSERT INTO user_artifacts VALUES (?, ?, ?, ?)').run(source.id, 'unique', b.id, '2026-01-02');
  merge(primary, source);
  const artifacts = row('user_artifacts', primary.id);
  assert.equal(artifacts.length, 2);
  assert(artifacts.every((item) => item.trigger_entry_id === a.id));
  assert.equal(artifacts.find((item) => item.artifact_id === 'shared').awarded_at, '2026-01-01');
});

test('support state union preserves credit on collisions and cannot be claimed twice', () => {
  const db = getDb();
  const { primary, source } = pair();
  const actions = db.prepare('SELECT * FROM support_actions WHERE active = 1 ORDER BY id LIMIT 2').all();
  db.prepare("INSERT INTO user_support_actions (user_id, action_id, status) VALUES (?, ?, 'shown')").run(primary.id, actions[0].id);
  for (const action of actions) openSupportAction(source.id, action.id, 'vk');
  const before = row('user_support_actions', source.id);
  merge(primary, source);
  assert.equal(row('user_support_actions', primary.id).length, 2);
  for (const original of before) {
    const saved = row('user_support_actions', primary.id).find((item) => item.action_id === original.action_id);
    assert.equal(saved.credited_at, original.credited_at);
    assert.equal(saved.status, 'opened');
    assert.equal(saved.source, 'vk');
  }
  const points = badgeForUser(primary.id).points;
  openSupportAction(primary.id, actions[0].id, 'web');
  assert.equal(badgeForUser(primary.id).points, points);
});

test('artifacts-only and support-only VK accounts are not disposable', () => {
  const db = getDb();
  for (const kind of ['artifact', 'support']) {
    const { primary, source } = pair();
    if (kind === 'artifact') db.prepare('INSERT INTO user_artifacts (user_id, artifact_id) VALUES (?, ?)').run(source.id, 'retained');
    else db.prepare('INSERT INTO user_support_actions (user_id, action_id) VALUES (?, ?)').run(source.id, db.prepare('SELECT id FROM support_actions LIMIT 1').get().id);
    const offer = merges.buildVkMergeOffer(primary.id, source.vk_id);
    assert.equal(offer.mergeRequired, true);
    assert.throws(() => users.linkVkUser(primary.id, source.vk_id));
    assert(users.getUserById(source.id));
    merge(primary, source);
    assert.equal(row(kind === 'artifact' ? 'user_artifacts' : 'user_support_actions', primary.id).length, 1);
  }
});

test('empty VK can link, same identity is idempotent, linked Telegram cannot be destroyed', () => {
  const { primary, source } = pair();
  assert.equal(merges.buildVkMergeOffer(primary.id, source.vk_id), null);
  users.linkVkUser(primary.id, source.vk_id);
  users.linkVkUser(primary.id, source.vk_id);
  assert.equal(users.getUserById(primary.id).vk_id, source.vk_id);
  assert.equal(users.getUserById(source.id), undefined);
  const other = tg();
  assert.throws(() => users.linkVkUser(other.id, source.vk_id));
  const preview = merges.buildMergePreview(other.id, primary.id);
  assert(preview.blocking.includes('source_telegram_conflict'));
  assert.equal(preview.canMerge, false);
  const res = invoke('/account/merge-vk/preview', other, { mergeToken: token(other, users.getUserById(primary.id)) });
  assert(res.data.preview.blocking.includes('source_telegram_conflict'));
  assert.throws(() => merge(other, users.getUserById(primary.id)), /merge blocked/);
  assert(users.getUserById(primary.id));
});

test('primary VK cannot be replaced, including an empty source and stale offered token', () => {
  const { primary, source } = pair();
  entries.createEntry(source.id, 'joy');
  const offer = merges.buildVkMergeOffer(primary.id, source.vk_id);
  users.linkVkUser(primary.id, String(++identity));
  assert.throws(() => users.linkVkUser(primary.id, source.vk_id));
  assert(merges.buildMergePreview(primary.id, source.id).blocking.includes('primary_vk_conflict'));
  assert.throws(() => merges.applyMergeByToken(offer.mergeToken, primary.id), /merge blocked/);
  const empty = vk();
  assert.equal(merges.buildVkMergeOffer(primary.id, empty.vk_id).preview.canMerge, false);
  assert(users.getUserById(source.id));
  assert(users.getUserById(empty.id));
});

test('duplicate credited support actions retain earliest timestamps and do not double badge points', () => {
  const db = getDb();
  const { primary, source } = pair();
  const action = db.prepare('SELECT * FROM support_actions WHERE active = 1 LIMIT 1').get();
  for (const [user, date] of [[primary, '2026-02-01'], [source, '2026-01-01']]) {
    db.prepare(`INSERT INTO user_support_actions
      (user_id, action_id, status, opened_at, claimed_at, verified_at, credited_at, metadata_json)
      VALUES (?, ?, 'verified', ?, ?, ?, ?, '{"proof":"same"}')`).run(user.id, action.id, date, date, date, date);
  }
  merge(primary, source);
  const saved = row('user_support_actions', primary.id)[0];
  for (const field of ['opened_at', 'claimed_at', 'verified_at', 'credited_at']) assert.equal(saved[field], '2026-01-01');
  assert.equal(saved.metadata_json, '{"proof":"same"}');
  assert.equal(saved.status, 'verified');
  assert.equal(badgeForUser(primary.id).points, action.reward_points);
});

test('conflicting opaque support metadata blocks atomically and exposes a preview reason', () => {
  const db = getDb();
  const { primary, source } = pair();
  const action = db.prepare('SELECT id FROM support_actions LIMIT 1').get();
  for (const user of [primary, source]) db.prepare('INSERT INTO user_support_actions (user_id, action_id, metadata_json) VALUES (?, ?, ?)').run(user.id, action.id, JSON.stringify({ proof: user.id }));
  entries.createEntry(source.id, 'joy', 'Must not move');
  const before = [row('user_support_actions', primary.id), row('user_support_actions', source.id), row('entries', source.id)];
  const res = invoke('/account/merge-vk/preview', primary, { mergeToken: token(primary, source) });
  assert.equal(res.data.preview.canMerge, false);
  assert(res.data.preview.blocking.includes('support_metadata_conflict'));
  assert.throws(() => merge(primary, source), /merge blocked/);
  assert.deepEqual([row('user_support_actions', primary.id), row('user_support_actions', source.id), row('entries', source.id)], before);
  assert(users.getUserById(source.id));
});

test('invalid and replayed tokens cannot mutate accounts; linked upserts retain locale', () => {
  const { primary, source } = pair();
  const originalToken = token(primary, source);
  assert.throws(() => merges.applyMergeByToken(originalToken, source.id), /target mismatch/);
  assert.throws(() => merges.applyMergeByToken(originalToken + 'x', primary.id), /invalid/);
  merge(primary, source);
  assert.throws(() => merges.applyMergeByToken(originalToken, primary.id), /users invalid/);
  users.updateLocale(primary.id, 'ru');
  assert.equal(users.upsertVkUser(source.vk_id, null, 'UTC', 'en', 'VK refreshed').locale, 'ru');
  assert.equal(users.upsertTelegramUser({ id: primary.telegram_id, first_name: 'TG refreshed', language_code: 'en' }).locale, 'ru');
  assert.equal(users.getUserById(primary.id).vk_id, source.vk_id);
});

test('referrals-only source is retained for confirmed merge without self-referral', () => {
  const { primary, source } = pair();
  getDb().prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(source.id, primary.id);
  assert.equal(merges.buildVkMergeOffer(primary.id, source.vk_id).mergeRequired, true);
  assert.throws(() => users.linkVkUser(primary.id, source.vk_id));
  merge(primary, source);
  assert.equal(users.getUserById(primary.id).referrer_id, null);
});

test('HTTP authenticated merge/history path preserves notes and returns correct conflict reasons', async () => {
  const express = require('express');
  const { createToken } = require('../src/auth/session');
  const app = express(); app.use(express.json({ limit: '64kb' })); app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (route, user, method = 'GET', body) => originalFetch(base + route, {
    method, headers: { authorization: `Bearer ${createToken(user.id)}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  try {
    const { primary, source } = pair();
    const entry = entries.createEntry(primary.id, 'joy', 'A'.repeat(2000));
    entries.createEntry(source.id, 'joy', 'B'.repeat(2000));
    const forged = await request('/account/merge-vk/confirm', source, 'POST', { mergeToken: token(primary, source) });
    assert.equal(forged.status, 400);
    const merged = await request('/account/merge-vk/confirm', primary, 'POST', { mergeToken: token(primary, source) });
    assert.equal(merged.status, 200);
    const note = row('entries', primary.id)[0].note;
    assert(note.includes('A'.repeat(2000)) && note.includes('B'.repeat(2000)));
    const edit = await request('/entries/' + entry.id, primary, 'PATCH', { note: note.replace('A', 'C') });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).entry.note.length, note.length);
    const other = tg();
    const conflict = await request('/account/merge-vk/confirm', other, 'POST', { mergeToken: token(other, users.getUserById(primary.id)) });
    assert.equal(conflict.status, 409);
    const error = await conflict.json();
    assert(error.preview.blocking.includes('source_telegram_conflict'));
    assert.match(error.error, /Telegram/);
    assert.doesNotMatch(error.error, /active contract/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('VK permission follows its identity through confirmed merge and empty linking, without overwriting preferences', () => {
  for (const needsMerge of [false, true]) {
    const { primary, source } = pair();
    users.updateSettings(primary.id, { timezone: 'UTC', eveningReminderTime: '07:31', remindersEnabled: false });
    users.updateVkMessagesAllowed(source.id, true);
    const permissionDate = users.getUserById(source.id).vk_messages_allowed_at;
    if (needsMerge) { entries.createEntry(source.id, 'joy'); merge(primary, source); }
    else users.linkVkUser(primary.id, source.vk_id);
    const user = users.getUserById(primary.id);
    assert.equal(user.vk_messages_allowed, 1);
    assert.equal(user.vk_messages_allowed_at, permissionDate);
    assert.equal(user.reminders_enabled, 0);
    assert.equal(user.timezone, 'UTC');
    assert.equal(user.evening_reminder_time, '07:31');
  }
});

test('duplicate reminder history does not abort merge or lose sent state', () => {
  const { primary, source } = pair();
  const db = getDb();
  db.prepare("INSERT INTO reminders (user_id, due_at, status) VALUES (?, '2026-01-01', 'scheduled')").run(primary.id);
  db.prepare("INSERT INTO reminders (user_id, due_at, status, sent_at) VALUES (?, '2026-01-01', 'sent', '2026-01-01 20:00:00')").run(source.id);
  merge(primary, source);
  const reminders = row('reminders', primary.id);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].status, 'sent');
  assert.equal(reminders[0].sent_at, '2026-01-01 20:00:00');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
