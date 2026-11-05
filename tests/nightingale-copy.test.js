const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.SCHEDULER_ENABLED = 'false';
require('dotenv').config = () => ({});
const denyOutbound = () => { throw new Error('Nightingale QA: outbound prohibited'); };
global.fetch = denyOutbound;
for (const module of ['node:http', 'node:https']) {
  require(module).request = denyOutbound;
  require(module).get = denyOutbound;
}
require('node:net').connect = denyOutbound;
require('node:net').createConnection = denyOutbound;

const { initDatabase, getDb, closeDb } = require('../src/db');
const { createEntry, deleteEntry } = require('../src/services/entriesService');
const { listArtifacts, awardArtifactsForUser } = require('../src/services/artifactsService');
const ID = 'nightingale_close_voices';
const COPY = {
  ru: 'Встреча случилась, когда за последние семь дней ты отметил общение и время с родными хотя бы по разу — и не меньше трёх раз в сумме.',
  en: 'The encounter happened when you noted contact with friends and time with family at least once each in the last seven days — and at least three times in total.'
};

beforeEach(() => initDatabase(':memory:'));
afterEach(() => closeDb());

function user(locale = 'ru', timezone = 'UTC') {
  return Number(getDb().prepare('INSERT INTO users (locale, timezone, created_at) VALUES (?, ?, ?)')
    .run(locale, timezone, '2026-11-03 00:00:00').lastInsertRowid);
}
function clock(t, iso = '2026-11-05T12:00:00Z') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });
  return (value) => t.mock.timers.setTime(new Date(value).getTime());
}
function encounter(id) {
  return listArtifacts(id).find((item) => item.id === ID);
}
function addAt(setTime, id, date, types) {
  setTime(date);
  return types.map((type) => createEntry(id, type));
}

for (const [social, family, expected] of [[1, 1, false], [3, 0, false], [0, 3, false], [2, 1, true], [1, 2, true]]) {
  test(`existing threshold: ${social} social + ${family} family => ${expected}`, (t) => {
    const setTime = clock(t);
    const id = user();
    for (let offset = 0; offset < Math.max(social, family); offset += 1) {
      setTime(`2026-11-0${5 - offset}T12:00:00Z`);
      if (offset < social) createEntry(id, 'social_contact');
      if (offset < family) createEntry(id, 'family_time');
    }
    setTime('2026-11-05T12:00:00Z');
    assert.equal(awardArtifactsForUser(id).some((item) => item.id === ID), expected);
    assert.equal(Boolean(encounter(id)), expected);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM user_artifacts WHERE user_id=? AND artifact_id=?').get(id, ID).n, expected ? 1 : 0);
  });
}

for (const [date, expected] of [['2026-10-29', false], ['2026-10-30', true], ['2026-11-06', false]]) {
  test(`seven-date window includes Oct30 through Nov5 only: pair on ${date}`, (t) => {
    const setTime = clock(t);
    const id = user();
    addAt(setTime, id, `${date}T12:00:00Z`, ['social_contact', 'family_time']);
    addAt(setTime, id, '2026-11-05T12:00:00Z', ['social_contact']);
    assert.equal(awardArtifactsForUser(id).some((item) => item.id === ID), expected);
  });
}

for (const [timezone, expected] of [['America/Los_Angeles', true], ['Pacific/Kiritimati', false]]) {
  test(`local-date lower cutoff follows ${timezone}, not UTC`, (t) => {
    const setTime = clock(t);
    const id = user('en', timezone);
    addAt(setTime, id, '2026-10-29T09:00:00Z', ['social_contact', 'family_time']);
    addAt(setTime, id, '2026-11-04T09:00:00Z', ['social_contact']);
    setTime('2026-11-05T00:30:00Z');
    assert.equal(awardArtifactsForUser(id).some((item) => item.id === ID), expected);
  });
}

for (const [timezone, expected] of [['America/Los_Angeles', false], ['Pacific/Kiritimati', true]]) {
  test(`local-date upper cutoff follows ${timezone}, not UTC`, (t) => {
    const setTime = clock(t);
    const id = user('ru', timezone);
    addAt(setTime, id, '2026-11-05T09:00:00Z', ['social_contact', 'family_time']);
    addAt(setTime, id, '2026-11-04T09:00:00Z', ['social_contact']);
    setTime('2026-11-05T00:30:00Z');
    assert.equal(awardArtifactsForUser(id).some((item) => item.id === ID), expected);
  });
}

test('earned encounter survives source-entry deletion, window expiry and locale change without duplicate awards', (t) => {
  clock(t);
  const id = user();
  createEntry(id, 'social_contact');
  createEntry(id, 'family_time');
  t.mock.timers.setTime(new Date('2026-11-06T12:00:00Z').getTime());
  createEntry(id, 'family_time');
  awardArtifactsForUser(id);
  const before = getDb().prepare('SELECT * FROM user_artifacts WHERE user_id=? ORDER BY artifact_id').all(id);
  assert.ok(encounter(id));
  for (const entry of getDb().prepare('SELECT id FROM entries WHERE user_id=?').all(id)) deleteEntry(id, entry.id);
  t.mock.timers.setTime(new Date('2026-12-05T12:00:00Z').getTime());
  getDb().prepare("UPDATE users SET locale='en', timezone='Pacific/Kiritimati' WHERE id=?").run(id);
  assert.deepEqual(awardArtifactsForUser(id), []);
  assert.equal(encounter(id).triggerText, COPY.en);
  assert.deepEqual(getDb().prepare('SELECT * FROM user_artifacts WHERE user_id=? ORDER BY artifact_id').all(id), before);
});

for (const locale of ['ru', 'en']) {
  test(`${locale}: day-three encounter explains the real count/window, not a week-long wait`, (t) => {
    const setTime = clock(t);
    const id = user(locale);
    for (const day of ['03', '04', '05']) {
      setTime(`2026-11-${day}T12:00:00Z`);
      createEntry(id, 'social_contact');
      createEntry(id, 'family_time');
    }
    assert.equal(getDb().prepare('SELECT COUNT(DISTINCT entry_date) AS n FROM entries WHERE user_id=?').get(id).n, 3);
    const awarded = awardArtifactsForUser(id).find((item) => item.id === ID);
    assert.ok(awarded, 'no account-age/seven-day gate');
    assert.equal(awarded.triggerText, COPY[locale]);
    assert.equal(encounter(id).triggerText, COPY[locale]);
  });
}
