const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const sharp = require('sharp');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-day-story-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DEV_AUTH_ENABLED: 'true', SCHEDULER_ENABLED: 'false',
  DB_PATH: path.join(temp, 'test.sqlite'), SESSION_SECRET: 'day-story-test-session-secret',
  DOTENV_CONFIG_PATH: '/dev/null', BOT_TOKEN: 'test-bot-token',
  APP_BASE_URL: 'http://127.0.0.1:1', WEBAPP_URL: 'http://127.0.0.1:1'
});
const config = require('../src/config');
const { createApp } = require('../src/server');
const store = require('../src/services/daySceneStoryService');
let server;
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  require('../src/db').closeDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('private day-scene image gets a bounded temporary HTTPS-ready URL, not a permanent profile card', async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.webappUrl = base; // Test only; production returns the configured HTTPS origin.
  const authResponse = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Story QA' }) });
  assert.equal(authResponse.status, 200);
  const { token } = await authResponse.json();
  const png = await sharp({ create: { width: 1080, height: 1920, channels: 4, background: '#fff8ef' } }).png().toBuffer();
  const upload = (data, type = 'image/png', bearer = token) => fetch(base + '/api/day-scene-story', {
    method: 'POST', headers: { 'Content-Type': type, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, body: data
  });
  assert.equal((await upload(png, 'image/png', '')).status, 401);
  assert.equal((await upload(Buffer.from('not a png'))).status, 400);
  assert.equal((await upload(png, 'text/plain')).status, 415);
  assert.equal((await upload(await sharp({ create: { width: 50, height: 50, channels: 4, background: 'red' } }).png().toBuffer())).status, 400);
  const first = await upload(png);
  assert.equal(first.status, 201);
  const { url } = await first.json();
  assert.equal(new URL(url).origin, base);
  assert.match(new URL(url).pathname, /^\/api\/day-scene-story\/[A-Za-z0-9_-]{43}\.png$/);
  const publicResult = await fetch(url);
  assert.equal(publicResult.status, 200);
  assert.match(publicResult.headers.get('content-type'), /^image\/png/);
  assert.match(publicResult.headers.get('cache-control'), /no-store/);
  const clean = Buffer.from(await publicResult.arrayBuffer());
  const metadata = await sharp(clean).metadata();
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1920);
  assert.equal(await fetch(url.replace('.png', 'X.png')).then(r => r.status), 404);
  const second = await upload(png);
  assert.equal(second.status, 201);
  assert.equal((await fetch(url)).status, 404, 'a newer story revokes the previous capability URL');
  const secondUrl = (await second.json()).url;
  for (let user = 1; user <= 16; user++) await store.create(10000 + user, png);
  assert.equal((await fetch(secondUrl)).status, 200, 'other users must not evict a prepared story');
  const id = secondUrl.split('/').pop().slice(0, -4);
  assert.equal(store.get(id, Date.now() + store.TTL_MS + 1000), null, 'the URL expires even without a cleanup timer');
});
