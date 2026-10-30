const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-reports-'));
process.env.DB_PATH = path.join(tmp, 'qa.sqlite');
process.env.NODE_ENV = 'test';
process.env.SCHEDULER_ENABLED = 'false';
require('dotenv').config = () => ({});
global.fetch = () => { throw Error('QA outbound prohibited'); };
const { getDb, closeDb } = require('../src/db');
const { createDemoUser } = require('../src/services/usersService');
const { getProductLayer } = require('../src/services/productContentService');
const { getCurrentContract } = require('../src/services/contractsService');

test('creation-local display start preserves historical storage and Sunday future start', () => {
  try {
    const user = createDemoUser('contract-period-fixture');
    const db = getDb();
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Pacific/Kiritimati', user.id);
    db.prepare(`INSERT INTO weekly_contracts (user_id,title,target_value,week_start,week_end,created_at)
      VALUES (?, 'Historical goal', 'Unchanged target', '2026-10-26','2026-11-01','2026-10-28 12:30:00')`).run(user.id);
    const before = db.prepare('SELECT * FROM weekly_contracts WHERE user_id=?').get(user.id);
    assert.equal(getCurrentContract(user.id).display_start, '2026-10-29');
    assert.deepEqual(db.prepare('SELECT * FROM weekly_contracts WHERE user_id=?').get(user.id), before);
    db.prepare("UPDATE weekly_contracts SET week_start='2026-11-02',week_end='2026-11-08',created_at='2026-10-31 12:30:00' WHERE user_id=?").run(user.id);
    assert.equal(getCurrentContract(user.id).display_start, '2026-11-02');
    for (const locale of ['ru','en']) {
      const product = getProductLayer(user.id, 'calm', locale);
      assert.ok(Number.isInteger(product.contractDays));
      assert.ok(product.contractDays >= 2 && product.contractDays <= 7);
    }
  } finally { closeDb(); fs.rmSync(tmp, {recursive:true, force:true}); }
});
