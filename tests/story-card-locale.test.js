const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');

// Block dotenv entirely: this fixture cannot load production credentials/DB.
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true, exports: { config() {} } };
const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'story-locale-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DEV_AUTH_ENABLED: 'true', SCHEDULER_ENABLED: 'false',
  DB_PATH: path.join(temp, 'test.sqlite'), SESSION_SECRET: 'isolated-story-locale-fixture-secret',
  BOT_TOKEN: '', BOT_USERNAME: '', VK_APP_ID: '', VK_SECURE_KEY: '', VK_GROUP_TOKEN: '',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', RESEND_API_KEY: '',
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
  APP_BASE_URL: 'http://127.0.0.1:1', WEBAPP_URL: 'http://127.0.0.1:1'
});
// Observe actual SVG passed to the real rasterizer, without replacing rendering.
const sharp = require('sharp');
const sharpPath = require.resolve('sharp');
const svgs = [];
require.cache[sharpPath].exports = new Proxy(sharp, {
  apply(target, receiver, args) {
    if (Buffer.isBuffer(args[0]) && args[0].toString().includes('<svg')) svgs.push(args[0].toString());
    return Reflect.apply(target, receiver, args);
  }
});
const config = require('../src/config');
const { createApp } = require('../src/server');
const { getDb, closeDb } = require('../src/db');
let server;
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  closeDb(); fs.rmSync(temp, { recursive: true, force: true });
});

test('saved EN/RU locale reaches public profile PNG and separates SVG/PNG cache without translating personal data', async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.webappUrl = base;
  const auth = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'Лада & Мир', locale: 'en' }) });
  assert.equal(auth.status, 200);
  const { token, user } = await auth.json();
  // Public cards intentionally exclude demo accounts; promote only this isolated fixture.
  getDb().prepare('UPDATE users SET is_demo = 0 WHERE id = ?').run(user.id);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  getDb().prepare("INSERT INTO entries (user_id,type,title,note,life_points,entry_date) VALUES (?, 'joy', 'Личная радость', 'СЕКРЕТНАЯ ЗАМЕТКА', 2, date('now'))").run(user.id);
  const seen = new Map();
  for (const locale of ['en', 'ru', 'en']) {
    const setting = await fetch(base + '/api/settings/locale', { method: 'POST', headers, body: JSON.stringify({ locale }) });
    assert.equal(setting.status, 200);
    const profile = (await (await fetch(base + '/api/profile', { headers })).json()).profile;
    for (const platform of ['telegram', 'vk']) {
      const url = profile[platform + 'StoryCardUrl'];
      assert.equal(new URL(url).searchParams.get('locale'), locale, 'profile must carry saved UI locale into unauthenticated native media URL');
      const count = svgs.length;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^image\/png/);
      const png = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(png).metadata();
      assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
      const key = platform + ':' + locale;
      if (seen.has(key)) {
        assert.deepEqual(png, seen.get(key));
        assert.equal(svgs.length, count, 'same locale hits bounded renderer cache');
      } else {
        assert.equal(svgs.length, count + 1);
        const svg = svgs.at(-1);
        assert(svg.includes('Лада &amp; Мир'), 'personal Cyrillic name is preserved and XML escaped');
        assert(!svg.includes('СЕКРЕТНАЯ') && !svg.includes('Личная радость'), 'private entry data is not projected');
        const texts = [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs)].map(m => m[1]).filter(text => text !== 'Лада &amp; Мир');
        if (locale === 'en') {
          assert(!texts.some(text => /[А-Яа-яЁё]/.test(text)), 'all fixed EN story labels must be English');
          assert(svg.includes('LIFE HARBOR')); assert(svg.includes('Open public profile'));
          assert(svg.includes('2 LIFE'));
        } else {
          assert(svg.includes('КОПИЛКА ЖИЗНИ')); assert(svg.includes('Открыть публичный профиль'));
          assert(svg.includes('2 ЖИЗНЬ'));
          assert.notDeepEqual(png, seen.get(platform + ':en'), 'RU cannot reuse EN PNG');
        }
        seen.set(key, png);
      }
    }
  }
  const { ref_code: code } = getDb().prepare('SELECT ref_code FROM users WHERE id = ?').get(user.id);
  const legacy = await fetch(base + `/api/story-card/${code}.png?platform=telegram`);
  assert.equal(legacy.status, 200, 'legacy URLs remain valid with Russian default');
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), seen.get('telegram:ru'));
});
