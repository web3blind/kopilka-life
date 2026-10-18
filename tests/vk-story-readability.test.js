const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

// No dotenv, production DB, credentials or provider traffic.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-vk-readability-'));
const configPath = require.resolve('../src/config');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
  nodeEnv: 'test', isProduction: false, dbPath: path.join(temp, 'test.sqlite'),
  schedulerEnabled: false, webappUrl: 'https://fixture.invalid',
  appBaseUrl: 'https://fixture.invalid', vkAppId: '123', botUsername: ''
} };
const { getDb, closeDb } = require('../src/db');
const { renderStoryCard, storyDestination } = require('../src/services/storyCardService');
const originalFetch = global.fetch;
global.fetch = () => { throw Error('External providers forbidden'); };
test.after(() => { global.fetch = originalFetch; closeDb(); fs.rmSync(temp, { recursive: true, force: true }); });

function contrast(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return 1.05 / (.2126 * r + .7152 * g + .0722 * b + .05);
}

test('VK profile PNG backs native white edge labels without hiding app labels or changing Telegram', async () => {
  const db = getDb();
  const metrics = {};
  for (const [label, name, code] of [['ru', 'Лада', 'READRU'], ['en', 'Alice', 'READEN'],
    ['ru-max', 'Ш'.repeat(48), 'R'.repeat(24)], ['en-max', 'W'.repeat(48), 'E'.repeat(24)]]) {
    db.prepare('INSERT INTO users (telegram_id, first_name, ref_code, timezone) VALUES (?, ?, ?, ?)').run('readability-' + label, name, code, 'UTC');
    const id = db.prepare('SELECT id FROM users WHERE ref_code=?').get(code).id;
    db.prepare("INSERT INTO entries (user_id,type,title,note,life_points,entry_date) VALUES (?, 'joy', 'Радость', 'PRIVATE-NOTE-MUST-NOT-APPEAR', 2, date('now'))").run(id);
    for (const platform of ['vk', 'telegram']) {
      const result = await renderStoryCard(code, platform);
      if (process.env.VK_STORY_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.VK_STORY_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.VK_STORY_EVIDENCE_DIR, `profile-${label}-${platform}-after.png`), result.png);
      }
      assert.deepEqual(Object.keys(result.card).sort(), ['activeDays', 'heart', 'name', 'todayLife', 'weekLife']);
      assert(!JSON.stringify(result.card).includes('PRIVATE-NOTE'));
      assert.equal(result.card.name, name); // Existing max-name clipping deliberately not changed.
      assert.equal(result.destination, storyDestination(code, platform));
      assert.strictEqual(await renderStoryCard(code, platform), result, 'cache lifecycle unchanged');
      const { data, info } = await sharp(result.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 1080); assert.equal(info.height, 1920);
      const pixel = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
      if (platform === 'vk') {
        let minimum = Infinity;
        let brandInk = 0, footerInk = 0;
        for (const [start, end] of [[0, 240], [1760, 1920]]) {
          for (let y = start; y < end; y++) for (let x = 0; x < 1080; x++) {
            const rgb = pixel(x, y);
            // Existing app ink occupies these boxes; native text cannot be
            // guaranteed readable if it overlaps app text. Test backing separately.
            const brand = x >= 90 && x < 530 && y >= 115 && y < 153;
            const footer = x >= 150 && x < 930 && y >= 1810 && y < 1850;
            if (brand || footer) {
              if (rgb[0] > 230 && rgb[1] > 230 && rgb[2] > 220) {
                if (brand) brandInk++; else footerInk++;
              }
            } else minimum = Math.min(minimum, contrast(rgb));
          }
        }
        assert(minimum >= 4.5, `${label}: white backing contrast ${minimum}`);
        assert(brandInk > 500, 'brand remains visible in light ink');
        assert(footerInk > 500, 'footer remains visible in light ink');
        const appInkContrast = contrast([37, 54, 47]) / contrast([255, 250, 240]);
        assert(appInkContrast >= 4.5, 'light app brand/footer ink remains readable');
        metrics[label] = { minimumWhiteBackingContrast: minimum, appInkContrast, brandInk, footerInk };
        assert.deepEqual(pixel(0, 239), [37, 54, 47]);
        assert.notDeepEqual(pixel(0, 240), [37, 54, 47], 'hard top transition at 240');
        assert.notDeepEqual(pixel(0, 1759), [37, 54, 47]);
        assert.deepEqual(pixel(0, 1760), [37, 54, 47], 'hard bottom transition at 1760');
      } else {
        assert(contrast(pixel(0, 0)) < 4.5, 'Telegram keeps original light top');
        assert(contrast(pixel(0, 1919)) < 4.5, 'Telegram keeps original light bottom');
      }
    }
  }
  console.log('VK profile contrast:', JSON.stringify(metrics));
});
