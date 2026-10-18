const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.WEBAPP_URL = 'https://life.blinddev.xyz';
const { createApp } = require('../src/server');
const { closeDb, getDb } = require('../src/db');
const { createToken } = require('../src/auth/session');
const { upsertTelegramUser } = require('../src/services/usersService');
const config = require('../src/config');
const { googleHandoff } = require('../src/auth/googleHandoff');

test('iframe intent only becomes Google state after first-party top-level authorize', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'google-handoff-'));
  const oldDb = config.dbPath;
  config.dbPath = path.join(dir, 'db.sqlite');
  let server;
  try {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const user = upsertTelegramUser({ id: 12981, first_name: 'Lada' });
    const start = await fetch(base + '/api/auth/google/start', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${createToken(user.id)}` },
      body: JSON.stringify({ link: true }) });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('set-cookie'), null, 'iframe response must not set a third-party cookie');
    const { launchUrl, channel } = await start.json();
    assert.match(channel, /^[A-Za-z0-9_-]{32,128}$/);
    assert.equal(new URL(launchUrl).origin, 'https://life.blinddev.xyz');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_states').get().n, 0);
    const authorize = base + new URL(launchUrl).pathname + new URL(launchUrl).search;
    const redirect = await fetch(authorize, { redirect: 'manual' });
    assert.equal(redirect.status, 303);
    assert.match(redirect.headers.get('set-cookie'), /^kopilka_google_browser=/);
    assert.match(redirect.headers.get('referrer-policy'), /no-referrer/);
    const google = new URL(redirect.headers.get('location'));
    assert.equal(google.origin, 'https://accounts.google.com');
    assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
    const state = google.searchParams.get('state');
    const row = getDb().prepare('SELECT * FROM google_oauth_states').get();
    assert.equal(row.user_id, user.id);
    assert.equal(row.handoff_channel, channel);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_intents').get().n, 0);
    assert.equal((await fetch(authorize, { redirect: 'manual' })).status, 400, 'intent is one-use');
    const wrongCookie = await fetch(base + '/api/auth/google/callback?state=' + state + '&error=access_denied');
    assert.match(await wrongCookie.text(), /Не удалось подтвердить/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_states').get().n, 1, 'wrong browser cannot consume state');
    const cookie = redirect.headers.get('set-cookie').split(';')[0];
    const denied = await fetch(base + '/api/auth/google/callback?state=' + state + '&error=access_denied', { headers: { cookie } });
    assert.equal(denied.status, 200);
    const html = await denied.text();
    assert.match(html, new RegExp(channel));
    assert.match(html, /postMessage/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM google_oauth_states').get().n, 0);
    assert.equal((await fetch(base + '/api/auth/google/callback?state=' + state + '&error=access_denied', { headers: { cookie } })).status, 200);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM login_identities WHERE provider='google'").get().n, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDb(); config.dbPath = oldDb;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('callback handoff closes on matching opener acknowledgement, never puts bearer in URL', () => {
  const { html, csp } = googleHandoff({ token: 'test-only-token', channel: 'test-only-channel' });
  assert.match(html, /window\.opener\.postMessage/);
  assert.match(html, /window\.close\(\)/);
  assert.match(html, /event\.origin === location\.origin/);
  assert.doesNotMatch(html, /\?google_oauth_return=1[^'"<]*token=/);
  assert.match(csp, /frame-ancestors 'none'/);
});
