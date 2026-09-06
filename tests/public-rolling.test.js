const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const vm = require('node:vm');
const sharp = require('sharp');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-rolling-'));
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.NODE_ENV = 'test';
process.env.SCHEDULER_ENABLED = 'false';
process.env.BOT_TOKEN = 'test-token';
process.env.SESSION_SECRET = 'test-secret';
const { getDb, closeDb } = require('../src/db');
const { getWeekSummary } = require('../src/services/entriesService');
const { publicProfileByCode } = require('../src/services/referralService');
const { renderStoryCard } = require('../src/services/storyCardService');

async function main() {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-06T16:59:59.999Z') });
  const db = getDb();
  const owner = db.prepare("INSERT INTO users (telegram_id, first_name, timezone, locale, ref_code) VALUES ('rolling-owner', 'Rolling Owner', 'Asia/Novosibirsk', 'ru', 'ROLL7D')").run().lastInsertRowid;
  const other = db.prepare("INSERT INTO users (telegram_id, first_name, timezone, locale, ref_code) VALUES ('rolling-other', 'Other', 'America/Adak', 'en', 'OTHER7')").run().lastInsertRowid;
  const insert = db.prepare("INSERT INTO entries (user_id, type, title, note, life_points, entry_date) VALUES (?, 'joy', 'Радость', 'PRIVATE-NOTE', ?, ?)");
  function seed(dates) {
    db.prepare('DELETE FROM entries').run();
    dates.forEach(([date, points]) => insert.run(owner, points, date));
    insert.run(other, 999, dates[1][0]);
  }
  seed([['2026-08-30', 100], ['2026-08-31', 1], ['2026-09-01', 2], ['2026-09-06', 4]]);
  let profile = publicProfileByCode('roll7d');
  assert.equal(profile.week.weekLife, 7, 'Sunday includes Monday through Sunday, not earlier Sunday');
  assert.equal(profile.week.activeDays, 3);
  assert.equal(getWeekSummary(owner).weekLife, 7, 'internal Sunday remains calendar week');
  mock.timers.setTime(new Date('2026-09-06T17:00:00.000Z').getTime());
  profile = publicProfileByCode('ROLL7D');
  assert.equal(profile.today.todayLife, 0);
  assert.equal(profile.week.weekLife, 6, 'local Monday retains preceding six days without resetting to zero');
  assert.equal(profile.week.activeDays, 2);
  assert.equal(getWeekSummary(owner).weekLife, 0, 'internal Monday resets to calendar week');
  insert.run(owner, 8, '2026-09-07');
  insert.run(owner, 200, '2026-09-08');
  profile = publicProfileByCode('ROLL7D');
  assert.equal(profile.week.weekLife, 14, 'both inclusive bounds count and future date is excluded');
  assert.deepEqual(profile.week.days.map((day) => day.date), ['2026-09-07', '2026-09-06', '2026-09-01']);
  assert.equal(profile.week.activeDays, 3);
  assert.deepEqual(profile.week.topCategories, [{ title: 'Радость', count: 3 }]);
  assert.equal(getWeekSummary(owner).weekLife, 208, 'legacy internal lower-bound-only semantics remain unchanged');
  assert(!JSON.stringify(profile).includes('PRIVATE-NOTE'));
  assert.equal(profile.week.entries, undefined);
  for (const platform of ['telegram', 'vk']) {
    const result = await renderStoryCard('ROLL7D', platform);
    assert.equal(result.card.weekLife, 14, `${platform} story uses rolling public aggregate`);
    assert.equal(result.card.activeDays, 3);
    const meta = await sharp(result.png).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 1080);
    assert.equal(meta.height, 1920);
  }
  db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('America/Adak', owner);
  assert.equal(publicProfileByCode('ROLL7D').week.weekLife, 7, 'same UTC instant is still Sunday west of UTC');
  const cases = [
    ['UTC', '2027-01-01T00:00:00Z', '2026-12-25', '2026-12-26', '2027-01-01', '2027-01-02'],
    ['UTC', '2024-03-01T12:00:00Z', '2024-02-23', '2024-02-24', '2024-03-01', '2024-03-02'],
    ['America/New_York', '2026-03-09T04:00:00Z', '2026-03-02', '2026-03-03', '2026-03-09', '2026-03-10'],
    ['America/New_York', '2026-11-02T05:00:00Z', '2026-10-26', '2026-10-27', '2026-11-02', '2026-11-03']
  ];
  for (const [zone, instant, before, start, end, after] of cases) {
    mock.timers.setTime(new Date(instant).getTime());
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(zone, owner);
    seed([[before, 100], [start, 2], [end, 4], [after, 200]]);
    profile = publicProfileByCode('ROLL7D');
    assert.equal(profile.week.weekLife, 6, `${zone} ${end}: calendar bounds across year/leap/DST`);
    assert.deepEqual(profile.week.days.map((day) => day.date), [end, start]);
    assert.equal(profile.week.activeDays, 2);
  }
  db.prepare('DELETE FROM entries WHERE user_id = ?').run(owner);
  assert.deepEqual(publicProfileByCode('ROLL7D').week, { weekLife: 0, activeDays: 0, days: [], topCategories: [] });
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), context);
  const { t } = context.window.KopilkaI18n;
  assert.equal(t('ru', 'publicWeek'), 'За последние 7 дней');
  assert.equal(t('en', 'publicWeek'), 'Last 7 days');
  assert.equal(t('ru', 'weekLifeLabel'), 'За текущую неделю: ');
  assert.equal(t('en', 'weekLifeLabel'), 'Current week: ');
  console.log('public rolling tests passed: Sunday/Monday, owner timezone, inclusive bounds, future exclusion, year/leap/DST, privacy, empty range, unchanged internal week, real Telegram/VK PNGs, labels');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  mock.timers.reset();
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
