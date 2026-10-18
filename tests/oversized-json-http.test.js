const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// No project .env or provider credentials: load the real app from a scratch cwd.
const root = path.resolve(__dirname, '..');
const originalCwd = process.cwd();
const evidenceDir = process.env.KOPILKA_413_EVIDENCE_DIR;
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
const scratch = fs.mkdtempSync(path.join(evidenceDir || process.env.TMPDIR || os.tmpdir(), 'kopilka-413-'));
const port = Number(process.env.KOPILKA_QA_PORT || 0);
fs.symlinkSync(path.join(root, 'migrations'), path.join(scratch, 'migrations'), 'dir');
fs.symlinkSync(path.join(root, 'public'), path.join(scratch, 'public'), 'dir');
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'TMPDIR', 'HOME', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', DB_PATH: path.join(scratch, 'qa.sqlite'),
  SESSION_SECRET: 'isolated-oversized-json-fixture-secret', SCHEDULER_ENABLED: 'false',
  DEV_AUTH_ENABLED: 'false', RATE_LIMIT_API_MAX: '10000'
});
process.chdir(scratch);
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  const target = new URL(url);
  if (target.protocol === 'http:' && target.hostname === '127.0.0.1') return originalFetch(url, options);
  throw new Error('External requests forbidden in oversized JSON QA');
};
const http = require('node:http');
const https = require('node:https');
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
http.request = (...args) => {
  const target = typeof args[0] === 'string' || args[0] instanceof URL ? new URL(args[0]) : args[0];
  if ((target.hostname || target.host) !== '127.0.0.1') throw new Error('External HTTP forbidden');
  return originalHttpRequest(...args);
};
https.request = () => { throw new Error('External HTTPS forbidden'); };
const config = require('../src/config');
const { createApp } = require('../src/server');
const { getDb, closeDb } = require('../src/db');
const { createToken } = require('../src/auth/session');
let server;

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  closeDb();
  global.fetch = originalFetch;
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
  process.chdir(originalCwd);
  if (!evidenceDir) fs.rmSync(scratch, { recursive: true, force: true });
});

test('actual oversized JSON uses verified stored RU/EN locale, rejects without writes or text leaks', async () => {
  assert.equal(config.schedulerEnabled, false);
  for (const key of ['botToken', 'vkSecureKey', 'vkGroupToken', 'vkOAuthClientSecret', 'resendApiKey', 'googleClientSecret', 'vapidPrivateKey']) assert.equal(config[key], '');
  server = createApp().listen(port, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = getDb();
  const tokens = {};
  for (const locale of ['ru', 'en']) {
    const id = Number(db.prepare('INSERT INTO users(first_name,locale,timezone,reminders_enabled) VALUES(?,?,?,1)').run('413 fixture', locale, 'UTC').lastInsertRowid);
    tokens[locale] = createToken(id);
  }
  const revokedId = Number(db.prepare("INSERT INTO users(first_name,locale) VALUES('Revoked fixture','en')").run().lastInsertRowid);
  tokens.revoked = createToken(revokedId);
  db.prepare('UPDATE users SET session_revision=1 WHERE id=?').run(revokedId);
  tokens.expired = createToken(revokedId, Date.now() - 400 * 86400000);
  const snapshot = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY rowid`).all()]));
  const before = snapshot();
  const changesBefore = db.prepare('SELECT total_changes() AS n').get().n;
  // SQLite itself rejects any accidental writes throughout all rejected requests.
  db.pragma('query_only = ON');
  const marker = 'PRIVATE_413_SUBMITTED_TEXT_NOT_FOR_RESPONSE';
  const oversized = JSON.stringify({ title: marker + 'я'.repeat(35000), targetValue: 'One small step', locale: 'en' });
  assert.ok(Buffer.byteLength(oversized) > 65536);
  const observations = [];
  async function request(label, body, token, route = '/api/contracts') {
    const response = await global.fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
    const text = await response.text();
    const item = { label, requestBytes: Buffer.byteLength(body), status: response.status, body: JSON.parse(text) };
    assert.ok(!text.includes(marker), 'submitted text must not be echoed');
    observations.push(item);
    return item;
  }
  await request('ru stored locale overrides submitted en', oversized, tokens.ru);
  await request('en stored locale', oversized, tokens.en);
  await request('anonymous defaults ru', oversized);
  await request('forged bearer defaults ru', oversized, tokens.en.slice(0, -1) + '!');
  await request('revoked bearer defaults ru', oversized, tokens.revoked);
  await request('expired bearer defaults ru', oversized, tokens.expired);
  await request('oversized malformed JSON defaults ru', '{' + marker + 'x'.repeat(70000));
  await request('reminders route oversized EN', oversized, tokens.en, '/api/settings/reminders');
  await request('small malformed JSON regression', '{"title":');
  const prefix = '{"unused":"';
  const suffix = '"}';
  const exactLimit = prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix;
  await request('exact 64KiB reaches auth unchanged', exactLimit);
  await request('64KiB plus one is rejected', exactLimit + ' ');
  assert.deepEqual(snapshot(), before, 'all SQL rows including reminders and contracts are unchanged');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
  const evidence = { base, scratch, dbPath: config.dbPath, schedulerEnabled: config.schedulerEnabled, providersEmpty: true, outboundBlocked: true, queryOnlyDuringRequests: true, sqlRowsUnchanged: true, sqlChangesDuringRequests: 0, observations };
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
  const messages = {
    ru: 'Текст слишком длинный. Сократи его и попробуй ещё раз. Ничего не сохранено.',
    en: 'The text is too long. Shorten it and try again. Nothing was saved.'
  };
  for (const [index, item] of observations.entries()) {
    if (index === 8) { assert.deepEqual(item, { ...item, status: 500, body: { error: 'internal error' } }); continue; }
    if (index === 9) { assert.equal(item.status, 401); assert.equal(item.body.code, 'SESSION_INVALID'); continue; }
    const locale = index === 1 || index === 7 ? 'en' : 'ru';
    assert.equal(item.status, 413, item.label);
    assert.deepEqual(item.body, { error: messages[locale], code: 'PAYLOAD_TOO_LARGE' }, item.label);
    assert.doesNotMatch(item.body.error, /payload too large/i);
  }
});
