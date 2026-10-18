const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpush = require('web-push');
require('dotenv').config = () => ({});
process.env.NODE_ENV = 'test';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-push-'));
const config = require('../src/config');
const vapid = webpush.generateVAPIDKeys();
Object.assign(config, { dbPath: path.join(temp, 'test.db'), vapidPublicKey: vapid.publicKey,
  vapidPrivateKey: vapid.privateKey, vapidSubject: 'mailto:qa@example.org', isProduction: false });
const { getDb, closeDb } = require('../src/db');
const push = require('../src/services/pushService');
let tgCount = 0, vkCount = 0, pushCalls = [];
require('../src/telegram').sendReminder = async () => { tgCount++; if (fail === 'telegram') throw new Error('network'); };
require('../src/vkMessages').sendVkReminder = async () => { vkCount++; if (fail === 'vk') throw Object.assign(new Error('transient'), { code: 6 }); };
const originalSend = push.sendPush;
push.sendPush = async row => { pushCalls.push(row.subscription_id); if (fail === `push:${row.subscription_id}`) throw Object.assign(new Error('push 503'), { statusCode: 503 }); };
const reminder = require('../src/services/remindersService');
const db = getDb();
let fail = '';
const crypto = require('node:crypto');
const key = crypto.createECDH('prime256v1').generateKeys().toString('base64url');
const auth = crypto.randomBytes(16).toString('base64url');
const sub = suffix => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${'a'.repeat(64)}${suffix}`, keys: { p256dh: key, auth } });
function setup({ channels = true } = {}) {
  const id = Number(db.prepare('INSERT INTO users (telegram_id, vk_id, vk_messages_allowed, reminders_enabled) VALUES (?, ?, ?, 1)')
    .run(channels ? String(Math.random()).slice(2) : `email:${Math.random()}`, channels ? String(Math.random()).slice(2) : null, channels ? 1 : 0).lastInsertRowid);
  const due = Number(db.prepare("INSERT INTO reminders (user_id, due_at) VALUES (?, '2020-01-01T00:00:00.000Z')").run(id).lastInsertRowid);
  return { id, due };
}
function statuses(due) { return db.prepare('SELECT channel,subscription_id,status,attempts FROM reminder_deliveries WHERE reminder_id = ? ORDER BY id').all(due); }
function advance(due) {
  db.prepare("UPDATE reminders SET retry_after = '2020-01-01' WHERE id = ?").run(due);
  db.prepare("UPDATE reminder_deliveries SET retry_after = '2020-01-01' WHERE reminder_id = ? AND status = 'scheduled'").run(due);
}
after(() => { push.sendPush = originalSend; closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });

test('VAPID contact accepts a valid HTTPS origin as well as mailto', () => {
  const previous = config.vapidSubject;
  try {
    config.vapidSubject = 'https://life.blinddev.xyz';
    assert.equal(push.configured(), true);
    assert.doesNotThrow(() => webpush.setVapidDetails(config.vapidSubject, vapid.publicKey, vapid.privateKey));
    config.vapidSubject = 'http://life.blinddev.xyz';
    assert.equal(push.configured(), false);
    config.vapidSubject = 'mailto:qa@example.org';
    assert.equal(push.configured(), true);
  } finally { config.vapidSubject = previous; }
});

test('endpoint policy rejects SSRF, credentials, noncanonical URLs, malformed keys and caps devices', () => {
  const { id } = setup({ channels: false });
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x',
    'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com/x?q=1',
    'https://fcm.googleapis.com/%2fprivate', 'https://localhost/x']) {
    assert.throws(() => push.subscribe(id, { ...sub('bad'), endpoint }));
  }
  assert.throws(() => push.subscribe(id, { ...sub('bad'), keys: { p256dh: 'x', auth } }));
  for (let i = 0; i < 10; i++) push.subscribe(id, sub(`-${i}`));
  assert.equal(push.listSubscriptions(id).length, 10);
  assert.throws(() => push.subscribe(id, sub('-over')));
  const other = setup({ channels: false });
  assert.throws(() => push.subscribe(other.id, sub('-0')));
  assert.equal(push.unsubscribe(other.id, sub('-0').endpoint).removed, false);
  assert.equal(push.unsubscribe(id, sub('-0').endpoint).removed, true);
  db.prepare('DELETE FROM reminders WHERE user_id IN (?, ?)').run(id, other.id);
});

test('all channels and devices isolate failures; only failed channel retries', async () => {
  const { id, due } = setup();
  const one = sub('-fan1'), two = sub('-fan2');
  push.subscribe(id, one); push.subscribe(id, two);
  const subscriptions = push.listSubscriptions(id);
  const first = subscriptions.find(row => row.endpoint_hash === push.endpointHash(one.endpoint)).id;
  fail = `push:${first}`; tgCount = vkCount = 0; pushCalls = [];
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.equal(tgCount, 1); assert.equal(vkCount, 1); assert.equal(pushCalls.length, 2);
  assert.deepEqual(statuses(due).map(row => row.status), ['sent','sent','scheduled','sent']);
  fail = ''; advance(due);
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.equal(tgCount, 1); assert.equal(vkCount, 1); assert.equal(pushCalls.length, 3);
  assert.equal(db.prepare('SELECT status FROM reminders WHERE id = ?').get(due).status, 'sent');
  const second = setup(); push.subscribe(second.id, sub('-reverse'));
  tgCount = vkCount = 0; pushCalls = []; fail = 'vk';
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.equal(tgCount, 1); assert.equal(vkCount, 1); assert.equal(pushCalls.length, 1);
  assert.equal(statuses(second.due).find(row => row.channel === 'vk').status, 'scheduled');
  fail = ''; advance(second.due); await reminder.sendDueReminders();
  assert.equal(tgCount, 1); assert.equal(pushCalls.length, 1); assert.equal(vkCount, 2);
  const third = setup(); push.subscribe(third.id, sub('-telegram-fails'));
  tgCount = vkCount = 0; pushCalls = []; fail = 'telegram';
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.equal(vkCount, 1); assert.equal(pushCalls.length, 1);
  assert.equal(statuses(third.due).find(row => row.channel === 'telegram').status, 'failed');
  fail = '';
});

test('rebound Telegram/VK identities and crash recovery retire only unsafe channels', async () => {
  const { id, due } = setup();
  push.subscribe(id, sub('-rebound'));
  const original = db.prepare('SELECT telegram_id,vk_id FROM users WHERE id=?').get(id);
  db.prepare("UPDATE reminders SET attempts=1 WHERE id=?").run(due);
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,channel,recipient_key) VALUES (?,'telegram',?)").run(due, `telegram:${original.telegram_id}`);
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,channel,recipient_key) VALUES (?,'vk',?)").run(due, `vk:${original.vk_id}`);
  const oldSubId = push.listSubscriptions(id)[0].id;
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,channel,subscription_id,recipient_key) VALUES (?,'push',?,?)")
    .run(due, oldSubId, `push:${oldSubId}`);
  db.prepare("UPDATE users SET telegram_id = ?, vk_id = ? WHERE id = ?").run('999999', '999998', id);
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.deepEqual(db.prepare('SELECT channel,status FROM reminder_deliveries WHERE reminder_id=? ORDER BY channel').all(due), [
    { channel: 'push', status: 'sent' }, { channel: 'telegram', status: 'failed' }, { channel: 'vk', status: 'failed' }
  ]);
  const again = setup();
  push.subscribe(again.id, sub('-interrupted'));
  const subId = push.listSubscriptions(again.id)[0].id;
  db.prepare("UPDATE reminders SET status='sending',attempts=1 WHERE id=?").run(again.due);
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,channel,recipient_key,status) VALUES (?, 'telegram', ?, 'sent')")
    .run(again.due, `telegram:901${again.id}`);
  db.prepare("INSERT INTO reminder_deliveries(reminder_id,channel,subscription_id,recipient_key,status) VALUES (?,'push',?,?,'scheduled')")
    .run(again.due, subId, `push:${subId}`);
  const beforeTelegram = tgCount;
  assert(reminder.recoverInterruptedReminders() >= 1);
  assert.equal(db.prepare('SELECT status FROM reminders WHERE id=?').get(again.due).status, 'scheduled');
  assert.equal(await reminder.sendDueReminders(), 1);
  assert.equal(tgCount, beforeTelegram);
});

test('merge drops both browsers rather than transferring a former account device', () => {
  const primary = setup({ channels: false }), source = setup({ channels: false });
  push.subscribe(primary.id, sub('-merge-primary'));
  push.subscribe(source.id, sub('-merge-source'));
  db.prepare('DELETE FROM reminders WHERE user_id IN (?,?)').run(primary.id, source.id);
  require('../src/services/mergeRecords').moveRecords(db, primary.id, source.id);
  assert.equal(push.listSubscriptions(primary.id).length, 0);
  assert.equal(push.listSubscriptions(source.id).length, 0);
  assert.equal(reminder.scheduleNextReminderForUser(primary.id), null);
});

test('authenticated push API forbids strangers and cross-account removals', async () => {
  const { createApp } = require('../src/server');
  const { createToken } = require('../src/auth/session');
  const a = setup({ channels: false }), b = setup({ channels: false });
  const server = await new Promise(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const root = `http://127.0.0.1:${server.address().port}/api/settings/push`;
  const req = (path, method, user, body) => fetch(root + path, { method,
    headers: { 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${createToken(user)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await req('', 'GET')).status, 401);
    assert.equal((await req('', 'POST', null, sub('-http'))).status, 401);
    assert.equal((await req('', 'POST', a.id, sub('-http'))).status, 201);
    assert.deepEqual(await (await req('/status', 'POST', b.id, { endpoint: sub('-http').endpoint })).json(), { subscribed: false });
    assert.deepEqual(await (await req('', 'DELETE', b.id, { endpoint: sub('-http').endpoint })).json(), { subscribed: false, removed: false });
    assert.equal(push.listSubscriptions(a.id).length, 1);
    assert.deepEqual(await (await req('/status', 'POST', a.id, { endpoint: sub('-http').endpoint })).json(), { subscribed: true });
    assert.equal((await req('', 'POST', b.id, sub('-http'))).status, 400);
    assert.deepEqual(await (await req('', 'DELETE', a.id, { endpoint: sub('-http').endpoint })).json(), { subscribed: false, removed: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('expired subscription removed, unsubscribe and revision changes prevent stale delivery', async () => {
  const { id, due } = setup({ channels: false });
  const value = sub('-expired'); push.subscribe(id, value);
  push.sendPush = async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); };
  assert.equal(await reminder.sendDueReminders(), 0);
  assert.equal(push.listSubscriptions(id).length, 0);
  assert.equal(db.prepare('SELECT status FROM reminders WHERE id = ?').get(due).status, 'failed');
  push.sendPush = originalSend;
  const second = setup({ channels: false }); push.subscribe(second.id, sub('-revision'));
  db.prepare('UPDATE users SET session_revision = session_revision + 1 WHERE id = ?').run(second.id);
  assert.equal(await reminder.sendDueReminders(), 0);
  assert.equal(statuses(second.due).length, 0);
  assert.equal(push.unsubscribe(second.id, sub('-revision').endpoint).removed, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(second.id).n, 0);
});
