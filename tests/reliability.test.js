const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
// Import the real config validator, but NEVER read the project's .env.
require('dotenv').config = () => ({});
process.env.NODE_ENV = 'test';
process.env.SCHEDULER_ENABLED = 'false';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-reliability-'));
const config = require('../src/config');
Object.assign(config, {
  dbPath: path.join(temp, 'test.sqlite'), nodeEnv: 'development', isProduction: false,
  botToken: 'fixture', vkGroupToken: 'fixture', vkGroupId: '123', vkAppId: '123',
  webappUrl: 'https://fixture.invalid', vkOAuthClientId: '123',
  vkOAuthTokenUrl: 'https://id.vk.ru/oauth2/auth', vkOutboundTimeoutMs: 25
});
let vkSend = async () => {};
let tgSend = async () => {};
const vk = require('../src/vkMessages');
const realVkSend = vk.sendVkReminder;
vk.sendVkReminder = (...args) => vkSend(...args);
require('../src/telegram').sendReminder = (...args) => tgSend(...args);
const { getDb, closeDb, initDatabase, applyMigration } = require('../src/db');
const reminders = require('../src/services/remindersService');
const oauth = require('../src/auth/vkOAuth');
const scheduler = require('../src/scheduler/remindersScheduler');
const originalFetch = global.fetch;
global.fetch = async () => { throw new Error('Unexpected network call forbidden'); };
const db = getDb();
let serial = 1000;
const past = '2020-01-01T00:00:00.000Z';
function fixture({ allowed = 1, telegram = null } = {}) {
  const vkId = String(++serial);
  const userId = Number(db.prepare('INSERT INTO users (telegram_id, vk_id, vk_messages_allowed, reminders_enabled) VALUES (?, ?, ?, 1)').run(telegram, vkId, allowed).lastInsertRowid);
  const id = Number(db.prepare('INSERT INTO reminders (user_id, due_at) VALUES (?, ?)').run(userId, past).lastInsertRowid);
  return { userId, id, vkId };
}
const row = (id) => db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
function reset() {
  db.exec('DELETE FROM reminders; DELETE FROM users;');
  vkSend = async () => {};
  tgSend = async () => {};
}
after(() => {
  scheduler.stopRemindersScheduler();
  global.fetch = originalFetch;
  vk.sendVkReminder = realVkSend;
  closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('oldest 20 permanent failures cannot starve the next eligible user; no absent-channel churn', async () => {
  reset();
  const failed = Array.from({ length: 25 }, () => fixture());
  const good = fixture();
  let calls = 0;
  vkSend = async (id) => {
    calls++;
    if (id !== good.vkId) throw Object.assign(new Error('denied'), { code: 901 });
  };
  assert.equal(await reminders.sendDueReminders(), 0);
  assert.equal(await reminders.sendDueReminders(), 1);
  for (const item of failed) assert.equal(row(item.id).status, 'failed');
  assert.equal(row(good.id).status, 'sent');
  assert.equal(calls, 26);
  for (let i = 0; i < 3; i++) {
    reminders.scheduleRemindersForEnabledUsers();
    assert.equal(await reminders.sendDueReminders(), 0);
  }
  assert.equal(calls, 26);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reminders WHERE status = 'scheduled'").get().n, 1);
  const absent = fixture({ allowed: 0 });
  await reminders.sendDueReminders();
  assert.equal(row(absent.id).status, 'failed');
  assert.equal(reminders.scheduleNextReminderForUser(absent.userId), null);
});

test('temporary failure uses persistent 1m/5m backoff and stops after three attempts', async () => {
  reset();
  const item = fixture();
  let calls = 0;
  vkSend = async () => { calls++; throw Object.assign(new Error('temporary'), { code: 6 }); };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = Date.now();
    await reminders.sendDueReminders();
    const current = row(item.id);
    assert.equal(current.attempts, attempt);
    if (attempt < 3) {
      assert.equal(current.status, 'scheduled');
      assert(Date.parse(current.retry_after) >= before + (attempt === 1 ? 60000 : 300000));
      reminders.scheduleRemindersForEnabledUsers();
      assert.equal(db.prepare('SELECT count(*) AS n FROM reminders').get().n, 1);
      await reminders.sendDueReminders();
      assert.equal(calls, attempt);
      db.prepare('UPDATE reminders SET retry_after = ? WHERE id = ?').run(past, item.id);
    } else assert.equal(current.status, 'failed');
  }
  await reminders.sendDueReminders();
  assert.equal(calls, 3);
});

test('temporary recovery sends once; partial channel success never retries successful delivery', async () => {
  reset();
  const item = fixture();
  vkSend = async () => { throw new Error('network'); };
  await reminders.sendDueReminders();
  db.prepare('UPDATE reminders SET retry_after = ? WHERE id = ?').run(past, item.id);
  vkSend = async () => {};
  assert.equal(await reminders.sendDueReminders(), 1);
  assert.equal(row(item.id).attempts, 2);
  assert.equal(await reminders.sendDueReminders(), 0);
  const partial = fixture({ telegram: '123456' });
  let telegramCalls = 0;
  tgSend = async () => { telegramCalls++; };
  vkSend = async () => { throw new Error('temporary'); };
  assert.equal(await reminders.sendDueReminders(), 1);
  assert.equal(row(partial.id).status, 'sent');
  await reminders.sendDueReminders();
  assert.equal(telegramCalls, 1);
});

test('VK messages and OAuth bound both fetch and hanging bodies and abort the transport', { timeout: 3000 }, async () => {
  for (const stage of ['fetch', 'body']) {
    for (const operation of [() => vk.callVk('messages.send', {}), () => oauth.exchangeCode({ code: 'c', deviceId: 'device', codeVerifier: 'v', redirectUri: 'https://fixture.invalid/cb', state: 's' })]) {
      let signal;
      global.fetch = async (_, options) => {
        signal = options.signal;
        if (stage === 'fetch') return new Promise(() => {});
        return { ok: true, json: () => new Promise(() => {}) };
      };
      await assert.rejects(operation(), /timed out/);
      assert.equal(signal.aborted, true);
    }
  }
  global.fetch = async () => ({ ok: true, json: async () => ({ user_id: '123' }) });
  assert.equal((await oauth.exchangeCode({ code: 'c', deviceId: 'device', codeVerifier: 'v', redirectUri: 'https://fixture.invalid/cb', state: 's' })).user_id, '123');
  global.fetch = async () => { throw new Error('Unexpected network call forbidden'); };
});

test('scheduler ticks do not overlap, including stop/restart while delivery is pending', { timeout: 3000 }, async () => {
  reset();
  fixture();
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  vkSend = async () => { calls++; started(); await new Promise((resolve) => { release = resolve; }); };
  scheduler.startRemindersScheduler(5);
  await entered;
  const later = fixture();
  scheduler.stopRemindersScheduler();
  scheduler.startRemindersScheduler(5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(row(later.id).status, 'scheduled');
  scheduler.stopRemindersScheduler();
  vkSend = async () => { calls++; };
  release();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.startRemindersScheduler(1000);
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.stopRemindersScheduler();
  assert.equal(row(later.id).status, 'sent');
  assert.equal(calls, 2);
});

test('production rejects public placeholders/short secrets, preserving non-placeholder >=16-char configurations', () => {
  const settings = { ...config, nodeEnv: 'production', isProduction: true,
    sessionSecret: '25e2ad6ed093d814923321abbff62ef0', telegramWebhookSecret: 'ac970d3e12595dd99138404400e48152',
    sessionMaxAgeSeconds: 3600, vkOAuthAuthorizeUrl: 'https://id.vk.ru/authorize' };
  for (const key of ['sessionSecret', 'telegramWebhookSecret']) {
    for (const value of ['', 'short', 'replace_me', 'local-dev-secret-change-me', 'replace_with_32_or_more_random_characters', 'change_me_please_32_characters_long']) {
      assert.throws(() => config.validateRuntimeConfig({ ...settings, [key]: value }), /SECRET/);
    }
  }
  assert.doesNotThrow(() => config.validateRuntimeConfig(settings));
  assert.doesNotThrow(() => config.validateRuntimeConfig({ ...settings, sessionSecret: '83a1ef459b72ce09', telegramWebhookSecret: '2b51e82bfa48969a' }));
  assert.doesNotThrow(() => config.validateRuntimeConfig({ nodeEnv: 'test', sessionSecret: 'short' }));
});

test('real VK sender retains provider dedup key across ambiguous retries and keyboard fallback', async () => {
  reset();
  const item=fixture();
  const keys=[];
  let attempt=0;
  global.fetch=async (url,options)=>{
    if(String(url).endsWith('messages.getConversations')) return {ok:true,json:async()=>({response:{items:[]}})};
    assert(String(url).endsWith('messages.send'));
    keys.push(options.body.get('random_id'));
    attempt++;
    if(attempt===1) throw Error('acknowledgement lost after acceptance');
    if(attempt===2) return {ok:true,json:async()=>({error:{error_code:911,error_msg:'invalid keyboard'}})};
    return {ok:true,json:async()=>({response:123})};
  };
  vkSend=realVkSend;
  await reminders.sendDueReminders();
  db.prepare('UPDATE reminders SET retry_after=? WHERE id=?').run(past,item.id);
  assert.equal(await reminders.sendDueReminders(),1);
  assert.equal(keys.length,3);
  assert.equal(new Set(keys).size,1);
  assert(Number(keys[0])>0);
  const another=fixture();
  await reminders.sendDueReminders();
  assert.notEqual(keys.at(-1),keys[0]);
  assert.equal(row(another.id).status,'sent');
  global.fetch=async()=>{throw Error('Unexpected network call forbidden');};
});

test('ambiguous Telegram acknowledgement is not replayed, including mixed-channel failure', async()=>{
  reset();
  const item=fixture({telegram:'4321'});
  tgSend=async()=>{throw Error('response lost after acceptance');};
  vkSend=async()=>{throw Error('network');};
  await reminders.sendDueReminders();
  assert.equal(row(item.id).status,'failed');
  assert.equal(row(item.id).attempts,1);
});

test('startup retires interrupted sends without replay and schedules the next future reminder', async()=>{
  reset();
  const item=fixture({telegram:'1234'});
  db.prepare("UPDATE reminders SET status='sending',attempts=1 WHERE id=?").run(item.id);
  let calls=0;vkSend=tgSend=async()=>{calls++;};
  scheduler.startRemindersScheduler(1000);
  await new Promise(resolve=>setImmediate(resolve));
  scheduler.stopRemindersScheduler();
  assert.equal(row(item.id).status,'failed');
  assert.equal(calls,0);
  const next=db.prepare("SELECT * FROM reminders WHERE user_id=? AND status='scheduled'").get(item.userId);
  assert(next && Date.parse(next.due_at)>Date.now());
});

test('migration DDL and marker roll back together; connection PRAGMAs and restart are preserved', () => {
  const migrationDb = new Database(path.join(temp, 'migration.sqlite'));
  try {
    migrationDb.pragma('journal_mode = WAL');
    migrationDb.pragma('busy_timeout = 5000');
    migrationDb.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
    assert.throws(() => applyMigration(migrationDb, 'broken', 'CREATE TABLE partial (id INTEGER); INSERT INTO nonexistent VALUES (1);'));
    assert.equal(migrationDb.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(), undefined);
    assert.equal(migrationDb.prepare('SELECT * FROM _migrations').all().length, 0);
    migrationDb.exec("CREATE TRIGGER refuse_marker BEFORE INSERT ON _migrations BEGIN SELECT RAISE(ABORT, 'marker failure'); END;");
    assert.throws(() => applyMigration(migrationDb, 'marker', 'CREATE TABLE partial (id INTEGER);'), /marker failure/);
    assert.equal(migrationDb.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(), undefined);
    migrationDb.exec('DROP TRIGGER refuse_marker');
    applyMigration(migrationDb, 'valid', 'PRAGMA journal_mode = WAL;\nPRAGMA busy_timeout = 5000;\nCREATE TABLE complete (id INTEGER);');
    assert.equal(migrationDb.prepare('SELECT name FROM _migrations').get().name, 'valid');
    assert.equal(migrationDb.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(migrationDb.pragma('busy_timeout', { simple: true }), 5000);
  } finally { migrationDb.close(); }
  closeDb();
  const reopened = initDatabase(config.dbPath);
  assert.equal(reopened.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM _migrations WHERE name = '016_reminder_retries.sql'").get().n, 1);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
});
