const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.DEV_AUTH_ENABLED = 'true';
process.env.SCHEDULER_ENABLED = 'false';
const config = require('../src/config');
const { createApp } = require('../src/server');
test('email login API with fake Resend keeps records and never sends externally', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'email-http-'));
  const oldPath = config.dbPath, oldKey = config.resendApiKey, originalFetch = global.fetch;
  config.dbPath = path.join(dir, 'db.sqlite'); config.resendApiKey = 'test-only';
  let code = '';
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.resend.com/emails') {
      code = JSON.parse(options.body).text.match(/\d{6}/)[0];
      return new Response(JSON.stringify({ id: 'fake' }), { status: 200 });
    }
    return originalFetch(url, options);
  };
  let server;
  try {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, payload, token) => {
      const res = await originalFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await post('/api/auth/email/request', { email: 'new@example.net' })).status, 200);
    assert.match(code, /^\d{6}$/);
    const bad = code === '000000' ? '999999' : '000000';
    assert.equal((await post('/api/auth/email/verify', { email: 'new@example.net', code: bad })).status, 401);
    const login = await post('/api/auth/email/verify', { email: 'new@example.net', code });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal((await post('/api/auth/email/verify', { email: 'new@example.net', code })).status, 401);
    const me = await originalFetch(base + '/api/me', { headers: { Authorization: `Bearer ${login.body.token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, login.body.user.id);
    require('../src/db').getDb().prepare('UPDATE users SET reminders_enabled = 1 WHERE id = ?').run(login.body.user.id);
    assert.equal(require('../src/services/remindersService').scheduleNextReminderForUser(login.body.user.id), null);
    assert.equal(require('../src/db').getDb().prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?').get(login.body.user.id).n, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    require('../src/db').closeDb();
    global.fetch = originalFetch; config.dbPath = oldPath; config.resendApiKey = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
