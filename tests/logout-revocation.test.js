const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const cwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kopilka-logout-'));
fs.symlinkSync(path.join(root, 'migrations'), path.join(scratch, 'migrations'), 'dir');
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'TMPDIR', 'HOME', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(scratch, 'qa.sqlite'),
  SESSION_SECRET: 'isolated-logout-fixture', APP_BASE_URL: 'https://logout.example',
  SCHEDULER_ENABLED: 'false', DEV_AUTH_ENABLED: 'false', RATE_LIMIT_API_MAX: '10000' });
process.chdir(scratch);
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Outbound blocked');
  return originalFetch(url, options);
};
const http = require('node:http');
const https = require('node:https');
const originalRequest = http.request;
const originalHttpsRequest = https.request;
http.request = (...args) => {
  const target = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(args[0]) : args[0];
  if ((target.hostname || target.host) !== '127.0.0.1') throw new Error('Outbound blocked');
  return originalRequest(...args);
};
https.request = () => { throw new Error('Outbound blocked'); };
const express = require('express');
const database = require('../src/db');
const config = require('../src/config');
const session = require('../src/auth/session');
let server, base;
test.before(async () => {
  database.initDatabase();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', require('../src/routes/api'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  database.closeDb();
  global.fetch = originalFetch; http.request = originalRequest; https.request = originalHttpsRequest;
  process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true });
});
function user() {
  return Number(database.getDb().prepare("INSERT INTO users(first_name,timezone,reminders_enabled) VALUES('Logout fixture','UTC',0)").run().lastInsertRowid);
}
function signed(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
async function request(route, token, { method = 'GET', body, origin = 'https://logout.example', headers = {} } = {}) {
  const response = await fetch(base + '/api' + route, { method, headers: {
    ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
    Origin: origin, 'Content-Type': 'application/json', ...headers
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: (() => { try { return JSON.parse(text); } catch (_) { return null; } })(), cache: response.headers.get('cache-control') };
}
const logout = (token, options = {}) => request('/auth/logout', token, { method: 'POST', body: {}, ...options });
function snapshot() {
  const db = database.getDb();
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY 1`).all()]));
}
test('signed pathological timestamp and oversized bearer inputs are bounded', () => {
  const id = user(), now = Date.now();
  for (const data of [
    { v: 1, userId: id, iat: now, exp: 1e100 },
    { v: 1, userId: id, iat: now + 0.5, exp: now + 60000 },
    { v: 1, userId: id, iat: now, exp: now + 60000, padding: 'x'.repeat(5000) }
  ]) assert.equal(session.inspectActiveToken(signed(data)).status, 'invalid');
});
test('logout invalidates real API reads and reminder writes persistently, not other sessions', async () => {
  const id = user(), now = Date.now();
  const token = session.createToken(id, now), other = session.createToken(id, now);
  assert.equal((await request('/me', token)).status, 200);
  assert.equal((await request('/settings/reminders', token, { method: 'POST', body: { remindersEnabled: false, eveningReminderTime: '20:01', timezone: 'UTC' } })).status, 200);
  const before = database.getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
  const result = await logout(token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { loggedOut: true }); assert.equal(result.cache, 'no-store');
  const afterLogout = snapshot();
  assert.equal((await request('/me', token)).status, 401);
  assert.equal((await request('/settings/reminders', token, { method: 'POST', body: { remindersEnabled: true, eveningReminderTime: '21:59', timezone: 'UTC' } })).status, 401);
  assert.deepEqual(snapshot(), afterLogout, 'replayed read/write cannot change any SQL row');
  assert.deepEqual(database.getDb().prepare('SELECT * FROM users WHERE id=?').get(id), before);
  assert.equal((await request('/me', other)).status, 200);
  assert.equal((await logout(token)).status, 200);
  assert.equal(session.verifyToken(token), null);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const row = database.getDb().prepare('SELECT * FROM session_revocations WHERE token_hash=?').get(hash);
  assert.ok(row); assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(database.getDb().prepare('SELECT count(*) AS n FROM session_revocations WHERE token_hash=?').get(hash).n, 1);
  database.closeDb(); database.initDatabase();
  assert.equal((await request('/me', token)).status, 401);
  assert.equal((await request('/me', other)).status, 200);
  const fresh = session.createToken(id);
  assert.equal((await request('/me', fresh)).status, 200);
  assert.equal((await request('/settings/reminders', fresh, { method: 'POST', body: { remindersEnabled: false, eveningReminderTime: '20:02', timezone: 'UTC' } })).status, 200);
});
test('logout rejects malformed authentication, wrong origins and actor injection without SQL changes', async () => {
  const id = user(), token = session.createToken(id);
  const before = snapshot();
  for (const invalid of [undefined, '', 'invalid', token + 'x', 'x'.repeat(5000)]) {
    const response = await logout(invalid);
    assert.equal(response.status, 401); assert.equal(response.body.code, 'SESSION_INVALID');
    assert.equal(response.cache, 'no-store');
  }
  for (const origin of ['', 'null', 'http://logout.example', 'https://logout.example.evil', 'https://logout.example:444', 'https://logout.example/']) {
    assert.equal((await logout(token, { origin })).status, 403);
  }
  assert.equal((await logout(token, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await logout(token, { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await logout(token, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  for (const body of [null, [], { userId: id }, { token }, { allSessions: true }])
    assert.equal((await logout(token, { body })).status, 400);
  assert.equal((await logout(token, { headers: { Authorization: token } })).status, 401);
  assert.deepEqual(snapshot(), before);
  assert.equal((await request('/me', token)).status, 200);
});
test('legacy tokens without rev or jti remain valid until current-bearer logout', async () => {
  const id = user(), now = Date.now();
  const legacy = signed({ v: 1, userId: id, iat: now - 1000, exp: now + 60000 });
  const other = session.createToken(id);
  assert.equal((await request('/me', legacy)).status, 200);
  assert.equal((await logout(legacy)).status, 200);
  assert.equal((await request('/me', legacy)).status, 401);
  assert.equal((await logout(legacy)).status, 200);
  assert.equal((await request('/me', other)).status, 200);
  database.getDb().prepare('UPDATE users SET session_revision=1 WHERE id=?').run(id);
  assert.equal((await logout(legacy)).status, 401);
  assert.equal((await request('/me', other)).status, 401);
  assert.equal((await request('/me', session.createToken(id))).status, 200);
});
test('logout revalidates revision and user even after earlier revocation', async () => {
  for (const mutation of ['revision', 'deleted']) {
    const id = user(), token = session.createToken(id);
    const second = session.createToken(id);
    assert.equal((await logout(token)).status, 200);
    if (mutation === 'revision') database.getDb().prepare('UPDATE users SET session_revision=session_revision+1 WHERE id=?').run(id);
    else database.getDb().prepare('DELETE FROM users WHERE id=?').run(id);
    const before = snapshot();
    for (const bearer of [token, second]) {
      const result = await logout(bearer);
      assert.equal(result.status, 401); assert.equal(result.body.code, 'SESSION_INVALID');
      assert.equal((await request('/me', bearer)).status, 401);
    }
    assert.deepEqual(snapshot(), before);
  }
});
test('expired bearer is unusable and returns SESSION_EXPIRED without inserting revocations', async () => {
  const id = user(), now = Date.now();
  const token = signed({ v: 1, userId: id, iat: now - 2000, exp: now - 1, rev: 0 });
  const before = snapshot();
  for (const response of [await logout(token), await request('/me', token)]) {
    assert.equal(response.status, 401); assert.equal(response.body.code, 'SESSION_EXPIRED');
  }
  assert.deepEqual(snapshot(), before);
});
test('concurrent requests are idempotent and a cold process inherits persistent rejection', async () => {
  const id = user(), token = session.createToken(id), other = session.createToken(id);
  const results = await Promise.all(Array.from({ length: 8 }, () => logout(token)));
  assert.ok(results.every(r => r.status === 200 && r.body.loggedOut === true));
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, ['-e', `
    const fs=require('node:fs');
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const session=require(${JSON.stringify(path.join(root, 'src/auth/session'))});
    const db=require(${JSON.stringify(path.join(root, 'src/db'))});
    const result={revoked:session.inspectActiveToken(input.token).status,
      valid:session.verifyToken(input.other)!==null, repeat:session.revokeToken(input.token).status};
    db.closeDb();console.log(JSON.stringify(result));
  `], { cwd: scratch, env: process.env, input: JSON.stringify({ token, other }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { revoked: 'revoked', valid: true, repeat: 'revoked' });
});
test('a fresh real signed Telegram login after logout issues an independent usable bearer', async () => {
  const oldBotToken = config.botToken;
  config.botToken = 'isolated-telegram-logout-fixture';
  try {
    const params = new URLSearchParams({ user: JSON.stringify({ id: 9007652544, first_name: 'Synthetic logout login' }), auth_date: String(Math.floor(Date.now() / 1000)) });
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    const login = () => request('/auth/telegram', undefined, { method: 'POST', body: { initData: params.toString(), timezone: 'UTC' } });
    const first = await login();
    assert.equal(first.status, 200);
    assert.equal((await logout(first.body.token)).status, 200);
    const second = await login();
    assert.equal(second.status, 200);
    assert.equal(second.body.user.id, first.body.user.id);
    assert.ok(second.body.token !== first.body.token);
    assert.equal((await request('/me', second.body.token)).status, 200);
    assert.equal((await request('/me', first.body.token)).status, 401);
  } finally { config.botToken = oldBotToken; }
});
test('SQLite write failure rolls back revocation rather than reporting successful logout', async () => {
  const id = user(), token = session.createToken(id), db = database.getDb();
  const before = snapshot();
  db.exec("CREATE TEMP TRIGGER reject_logout BEFORE INSERT ON session_revocations BEGIN SELECT RAISE(ABORT,'Controlled logout failure'); END");
  try {
    const response = await logout(token);
    assert.equal(response.status, 500);
    assert.deepEqual(snapshot(), before);
    assert.equal((await request('/me', token)).status, 200);
  } finally { db.exec('DROP TRIGGER reject_logout'); }
});
test('additive migration preserves populated old tables and tolerates empty users', () => {
  const Database = require('better-sqlite3');
  const sql = fs.readFileSync(path.join(root, 'migrations/024_session_revocations.sql'), 'utf8');
  for (const populated of [false, true]) {
    const connection = new Database(':memory:');
    try {
      connection.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY); CREATE TABLE users(id INTEGER PRIMARY KEY, data TEXT);');
      if (populated) connection.prepare('INSERT INTO users(id,data) VALUES(1,?)').run('preserved');
      const before = connection.prepare('SELECT * FROM users').all();
      database.applyMigration(connection, '024_session_revocations.sql', sql);
      assert.deepEqual(connection.prepare('SELECT * FROM users').all(), before);
      assert.equal(connection.prepare('SELECT count(*) AS n FROM session_revocations').get().n, 0);
      assert.equal(connection.prepare('SELECT name FROM _migrations').get().name, '024_session_revocations.sql');
      assert.equal(connection.pragma('integrity_check', { simple: true }), 'ok');
    } finally { connection.close(); }
  }
});
