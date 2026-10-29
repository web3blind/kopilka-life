const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopilka-rest-'));
process.env.DB_PATH = path.join(tmp, 'qa.sqlite');
process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { getDb, closeDb } = require('../src/db');
const { createDemoUser } = require('../src/services/usersService');
const { getContractTemplates } = require('../src/services/productContentService');
const { createContract } = require('../src/services/contractsService');

test('rest template respects remaining contract days in owner timezone, is editable and optional RU/EN', () => {
  try {
    const user = createDemoUser('rest-fixture');
    getDb().prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Pacific/Kiritimati', user.id);
    // In this timezone it is Saturday; only two days remain in this contract week.
    const now = new Date('2026-10-30T12:00:00Z');
    for (const lang of ['ru', 'en']) {
      const item = getContractTemplates(lang, user.id, now).find(t => t.id === 'rest-evenings');
      assert.ok(item);
      assert.match(item.targetValue, /2/);
      assert.match(item.targetValue, /20:00/);
      assert.equal(item.stakeAmount, '');
      assert.equal(item.fundDescription, '');
      if (lang === 'en') assert.doesNotMatch(JSON.stringify(item), /[А-Яа-яЁё]/);
    }
    const monday = getContractTemplates('en', user.id, new Date('2026-10-26T00:00:00Z')).find(t => t.id === 'rest-evenings');
    assert.match(monday.targetValue, /3/);
    // Existing form chooses next week on Sunday; the template must agree.
    const sunday = getContractTemplates('en', user.id, new Date('2026-10-31T12:00:00Z')).find(t => t.id === 'rest-evenings');
    assert.match(sunday.targetValue, /3/);
    const made = createContract(user.id, { title: monday.title, targetValue: 'Only one evening, after 21:30', rewardDescription: monday.rewardDescription });
    assert.equal(made.target_value, 'Only one evening, after 21:30');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ?').get(user.id).n, 0);
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
