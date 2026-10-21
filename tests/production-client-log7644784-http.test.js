const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

// Real production HTTP path; no project .env, live DB, scheduler or providers.
// XFF's rightmost address simulates Nginx appending the real remote address.
const root = path.resolve(__dirname, '..');
const cwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'client-log-7644784-'));
for (const dir of ['migrations', 'public']) fs.symlinkSync(path.join(root, dir), path.join(scratch, dir));
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'TMPDIR', 'HOME', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'production', DB_PATH: path.join(scratch, 'isolated.sqlite'),
  SESSION_SECRET: 'qa-isolated-client-log-strong-secret',
  TELEGRAM_WEBHOOK_SECRET: 'qa_isolated_webhook_secret', SCHEDULER_ENABLED: 'false'
});
process.chdir(scratch);
let server, base;
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(url).origin !== base) throw new Error('Outbound fetch forbidden');
  return originalFetch(url, options);
};
const originalRequest = http.request;
http.request = (...args) => {
  const target = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(args[0]) : args[0];
  if ((target.hostname || target.host) !== '127.0.0.1') throw new Error('Outbound HTTP forbidden');
  return originalRequest(...args);
};
const originalHttpsRequest = https.request;
https.request = () => { throw new Error('Outbound HTTPS forbidden'); };
const config = require('../src/config');
const { createApp } = require('../src/server');
const { getDb, closeDb } = require('../src/db');
const { createToken } = require('../src/auth/session');
const logs = [];
const originalLog = console.log;
console.log = (...args) => logs.push(args.join(' '));
async function start(windowMs = 60000) {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  config.rateLimits.apiWindowMs = windowMs;
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
  logs.length = 0;
}
async function request(route, { ip = '198.51.100.7', body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(base + route, { method, headers: { 'X-Forwarded-For': ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, retry: response.headers.get('retry-after'), body: await response.json() };
}
const diagnostic = { event: 'startup_ready', details: 'stage=ready', platform: 'vk', version: 'qa' };
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  closeDb(); console.log = originalLog;
  global.fetch = originalFetch; http.request = originalRequest; https.request = originalHttpsRequest;
  process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true });
});

test('production client-log: 120 accepted then 121 rejected; fake identity/XFF prefixes cannot bypass', async () => {
  assert.equal(config.rateLimits.apiMax, 120);
  assert.equal(config.rateLimits.apiWindowMs, 60000);
  assert.equal(config.schedulerEnabled, false);
  for (const key of ['botToken', 'vkSecureKey', 'vkGroupToken', 'vkOAuthClientSecret', 'resendApiKey', 'googleClientSecret', 'vapidPrivateKey']) assert.equal(config[key], '');
  await start();
  assert.equal(server.listeners('request')[0].get('trust proxy'), 1);
  const id = Number(getDb().prepare("INSERT INTO users(first_name,timezone) VALUES('QA client log','UTC')").run().lastInsertRowid);
  const token = createToken(id);
  // First 30 anonymous requests represent a legitimate startup burst.
  for (let i = 0; i < 120; i++) {
    const response = await request('/api/client-log', {
      ip: `203.0.113.${i}, 198.51.100.7`, body: { ...diagnostic, userId: i },
      headers: i >= 30 ? { Authorization: i === 30 ? `Bearer ${token}` : `Bearer forged-${i}` } : {}
    });
    assert.equal(response.status, 200, `request ${i + 1}`);
  }
  const blocked = await request('/api/client-log', { body: diagnostic });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retry) >= 1 && Number(blocked.retry) <= 60);
  for (let i = 0; i < 5; i++) {
    const response = await request('/API/CLIENT-LOG/', {
      ip: `192.0.2.${i}, 203.0.113.${i}, 198.51.100.7`, body: { ...diagnostic, userId: 10000 + i },
      headers: { Authorization: i ? `Bearer forged-${i}` : `Bearer ${token}` }
    });
    assert.equal(response.status, 429);
  }
  assert.equal(logs.filter(line => line.startsWith('[client-log]')).length, 120);
  assert.equal((await request('/api/me', { headers: { Authorization: `Bearer ${token}` } })).status, 429, 'existing shared IP budget');
  assert.equal((await request('/api/client-log', { ip: '198.51.100.8', body: diagnostic })).status, 200);
  assert.equal((await request('/api/me', { ip: '198.51.100.8', headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await request('/api/entries', { ip: '198.51.100.8', headers: { Authorization: `Bearer ${token}` }, body: { type: 'joy' } })).status, 201);
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM entries WHERE user_id=?').get(id).n, 1);
});

test('general limiter expires and accepts diagnostics again (only test window shortened)', async () => {
  await start(5000);
  for (let i = 0; i < 120; i++) assert.equal((await request('/api/client-log', { body: diagnostic })).status, 200);
  const blocked = await request('/api/client-log', { body: diagnostic });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retry) >= 1 && Number(blocked.retry) <= 5);
  await new Promise(resolve => setTimeout(resolve, Number(blocked.retry) * 1000 + 50));
  assert.equal((await request('/api/client-log', { body: diagnostic })).status, 200);
});

test('64KiB JSON body bound and 240-character per-field log bound remain in effect', async () => {
  await start();
  const db = getDb();
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  db.pragma('query_only = ON');
  try {
    const prefix = '{"event":"boundary","details":"';
    const suffix = '"}';
    const exact = prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix;
    assert.equal(Buffer.byteLength(exact), 65536);
    assert.equal((await request('/api/client-log', { body: exact })).status, 200);
    const loggedBefore = logs.length;
    const oversized = await request('/api/client-log', { body: exact + ' ' });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(logs.length, loggedBefore);
    assert.ok(logs[0].length < 350);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  } finally { db.pragma('query_only = OFF'); }
});
