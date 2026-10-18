const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load configuration from an empty scratch cwd, never the project's live .env.
const root = path.resolve(__dirname, '..');
const originalCwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kopilka-contract-validation-'));
fs.symlinkSync(path.join(root, 'migrations'), path.join(scratch, 'migrations'), 'dir');
fs.symlinkSync(path.join(root, 'public'), path.join(scratch, 'public'), 'dir');
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'TMPDIR', 'HOME', 'NODE_PATH', 'NODE_TEST_CONTEXT'].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  NODE_ENV: 'test', DB_PATH: path.join(scratch, 'fixture.sqlite'),
  SESSION_SECRET: 'isolated-contract-validation-secret', SCHEDULER_ENABLED: 'false',
  DEV_AUTH_ENABLED: 'false', RATE_LIMIT_API_MAX: '10000'
});
process.chdir(scratch);
const localFetch = global.fetch;
global.fetch = (url, options) => {
  const target = new URL(url);
  if (target.protocol === 'http:' && target.hostname === '127.0.0.1') return localFetch(url, options);
  throw new Error('External provider calls are forbidden in contract validation tests');
};
const { createApp } = require('../src/server');
const { getDb, closeDb } = require('../src/db');
const { createContract, closeContract, getCurrentContract } = require('../src/services/contractsService');
const { createToken } = require('../src/auth/session');
const { t } = require('../src/i18n');
const { sanitizeText } = require('../src/utils/sanitize');
const { localDateInTimeZone, weekRangeForTimeZone } = require('../src/utils/timezone');
let server;
let base;
test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  closeDb();
  global.fetch = localFetch;
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});
function user(locale = 'ru', timezone = 'UTC') {
  return Number(getDb().prepare('INSERT INTO users (first_name, locale, timezone) VALUES (?, ?, ?)').run('Contract fixture', locale, timezone).lastInsertRowid);
}
const valid = () => ({ title: 'Посильная цель', targetValue: 'Один маленький шаг' });
function assertRejected(userId, input, key) {
  assert.throws(() => createContract(userId, input), { message: key });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM weekly_contracts WHERE user_id=?').get(userId).n, 0, 'invalid input must not create or truncate a contract');
}
const fields = [
  ['title', 'title', 120, 'error.contractTitleTooLong'],
  ['targetValue', 'target_value', 300, 'error.contractTargetTooLong'],
  ['stakeAmount', 'stake_amount', 40, 'error.contractStakeTooLong'],
  ['rewardDescription', 'reward_description', 300, 'error.contractRewardTooLong'],
  ['fundDescription', 'fund_description', 300, 'error.contractFundTooLong'],
  ['stakeCurrency', 'stake_currency', 20, 'error.contractCurrencyTooLong']
];
for (const [field, column, limit, key] of fields) {
  test(`${field}: exact boundary preserved; boundary+1 and large raw values rejected before sanitation`, () => {
    const value = (field === 'stakeAmount' ? '1' : 'Ж').repeat(limit);
    const created = createContract(user(), { ...valid(), [field]: value });
    assert.equal(created[column], value);
    for (const raw of [value + '1', '1'.repeat(20000), ' '.repeat(limit + 1), `<b>${value}</b>`]) {
      assertRejected(user(), { ...valid(), [field]: raw }, key);
    }
    if (field !== 'stakeAmount') {
      const emoji = '🌱'.repeat(limit / 2);
      assert.equal(createContract(user(), { ...valid(), [field]: emoji })[column], emoji);
      assertRejected(user(), { ...valid(), [field]: emoji + '🌱' }, key);
    }
  });
}
test('sanitation expansion cannot silently truncate a bounded raw field', () => {
  const raw = 'a.io '.repeat(20).trim();
  assert(raw.length <= 120);
  assert(sanitizeText(raw, { maxLength: 0 }).length > 120);
  assertRejected(user(), { ...valid(), title: raw }, 'error.contractTitleTooLong');
});
test('text fields reject objects, arrays, booleans and numbers instead of coercing or dropping them', () => {
  for (const field of ['title', 'targetValue', 'rewardDescription', 'fundDescription', 'stakeCurrency']) {
    for (const value of [{ text: 'hidden' }, ['hidden'], false, true, 0, 17]) {
      assertRejected(user(), { ...valid(), [field]: value }, 'error.contractTextType');
    }
  }
  for (const input of [undefined, null, [], true, 'text', 42]) assertRejected(user(), input, 'error.contractInputType');
});
test('required fields stay required after normalization; optional values and RUB default stay optional', () => {
  for (const field of ['title', 'targetValue']) {
    for (const value of [undefined, null, '', '  ', '<b></b>']) assertRejected(user(), { ...valid(), [field]: value }, 'error.contractFields');
  }
  for (const empty of [undefined, null, '', '  ']) {
    const c = createContract(user(), { ...valid(), stakeAmount: empty, stakeCurrency: empty, rewardDescription: empty, fundDescription: empty });
    assert.equal(c.stake_amount, '');
    assert.equal(c.stake_currency, 'RUB');
    assert.equal(c.reward_description, '');
    assert.equal(c.fund_description, '');
  }
});
test('existing safe text normalization and unrestricted custom asset names are preserved', () => {
  const c = createContract(user(), {
    title: '  <b>Цель</b>\u0000  ', targetValue: ' <i>Шаг</i> ',
    rewardDescription: ' <b>Чай</b> ', fundDescription: 'Время для себя',
    stakeCurrency: ' <b>Жетоны</b> ', stakeAmount: ' 12,50 '
  });
  assert.equal(c.title, 'Цель'); assert.equal(c.target_value, 'Шаг');
  assert.equal(c.reward_description, 'Чай'); assert.equal(c.fund_description, 'Время для себя');
  assert.equal(c.stake_currency, 'Жетоны'); assert.equal(c.stake_amount, '12.50');
  for (const currency of ['TON', 'USDT', 'Custom asset', 'баллы заботы']) {
    assert.equal(createContract(user(), { ...valid(), stakeCurrency: currency }).stake_currency, currency);
  }
});
test('symbolic stake accepts optional nonnegative decimals without rounding or changing precision', () => {
  for (const [input, expected] of [['0', '0'], [0, '0'], ['0,5', '0.5'], [12.5, '12.5'], ['00012,500', '00012.500'], ['0.0000000001', '0.0000000001'], ['1'.repeat(40), '1'.repeat(40)]]) {
    assert.equal(createContract(user(), { ...valid(), stakeAmount: input }).stake_amount, expected);
  }
});
test('symbolic stake rejects letters, negatives, nonfinite, exponents and malformed decimals', () => {
  for (const value of ['TEST', '-1', '-0', -1, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '1e3', '1E+3', 1e21, '+1', '1.2.3', '1,2.3', '1 000', '.5', '5.', {}, [], false, true, '<b>12</b>']) {
    assertRejected(user(), { ...valid(), stakeAmount: value }, 'error.contractStakeInvalid');
  }
});
test('close result preserves 500 characters and rejects invalid input atomically', () => {
  const id = user(); const contract = createContract(id, valid());
  const expanded = 'a.io '.repeat(40).trim();
  assert(expanded.length < 500 && sanitizeText(expanded, { maxLength: 0 }).length > 500);
  for (const value of ['Ж'.repeat(501), ' '.repeat(501), 'Ж'.repeat(20000), expanded]) {
    assert.throws(() => closeContract(id, contract.id, 'completed', value), { message: 'error.contractResultTooLong' });
    assert.equal(getCurrentContract(id).status, 'active');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id=?').get(id).n, 0);
  }
  for (const value of [false, true, 0, 12, [], {}]) {
    assert.throws(() => closeContract(id, contract.id, 'completed', value), { message: 'error.contractTextType' });
    assert.equal(getCurrentContract(id).status, 'active');
  }
  const note = 'Ж'.repeat(500);
  assert.equal(closeContract(id, contract.id, 'completed', note).result_note, note);
  assert.equal(getDb().prepare('SELECT note FROM entries WHERE user_id=?').get(id).note, note);
});
test('all close statuses, localized awards, ownership, duplicate prevention and dates are unchanged', () => {
  for (const locale of ['ru', 'en']) for (const [status, points] of Object.entries({ completed: 10, not_completed_donated: 3, too_hard: 0, cancelled: 0 })) {
    const id = user(locale, 'Pacific/Kiritimati');
    const now = new Date(); const today = localDateInTimeZone(now, 'Pacific/Kiritimati');
    let range = weekRangeForTimeZone('Pacific/Kiritimati', now);
    if (today >= range.weekEnd) range = weekRangeForTimeZone('Pacific/Kiritimati', new Date(now.getTime() + 86400000));
    const c = createContract(id, valid());
    assert.equal(c.week_start, range.weekStart); assert.equal(c.week_end, range.weekEnd);
    assert.equal(c.status, 'active'); assert.equal(c.isOver, false); assert.equal(c.isLastDay, false);
    assert.throws(() => createContract(id, valid()), { message: 'error.contractExists' });
    assert.throws(() => closeContract(user(), c.id, status), { message: 'error.contractNotFound' });
    assert.throws(() => closeContract(id, c.id, 'unknown'), { message: 'error.contractStatus' });
    const closed = closeContract(id, c.id, status, ' <b>Честный итог</b> ');
    assert.equal(closed.status, status); assert.equal(closed.result_note, 'Честный итог'); assert(closed.closed_at);
    assert.equal(getCurrentContract(id), null);
    const awards = getDb().prepare('SELECT * FROM entries WHERE user_id=?').all(id);
    assert.equal(awards.length, points ? 1 : 0);
    if (points) {
      assert.equal(awards[0].life_points, points); assert.equal(awards[0].entry_date, today);
      assert.equal(awards[0].title, t(locale, status === 'completed' ? 'contractEntry.completed' : 'contractEntry.honest'));
    }
    assert.throws(() => closeContract(id, c.id, status), { message: 'error.contractNotFound' });
  }
});
async function post(userId, route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${createToken(userId)}` }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
test('real authenticated HTTP path returns localized validation without partial writes, then saves valid input', async () => {
  for (const locale of ['ru', 'en']) {
    const id = user(locale);
    for (const [field, , limit, key] of fields) {
      for (const length of [limit + 1, 20000]) {
        const response = await post(id, '/api/contracts', { ...valid(), [field]: '1'.repeat(length) });
        assert.equal(response.status, 400); assert.equal(response.data.error, t(locale, key));
        assert.notEqual(response.data.error, key); assert.equal(getCurrentContract(id), null);
      }
    }
    for (const [field, value, key] of [['stakeAmount', 'letters', 'error.contractStakeInvalid'], ['rewardDescription', false, 'error.contractTextType']]) {
      const response = await post(id, '/api/contracts', { ...valid(), [field]: value });
      assert.equal(response.status, 400); assert.equal(response.data.error, t(locale, key));
    }
    const saved = await post(id, '/api/contracts', { ...valid(), stakeAmount: '12,50', stakeCurrency: 'Custom asset' });
    assert.equal(saved.status, 201); assert.equal(saved.data.contract.stake_amount, '12.50');
    assert.equal(getCurrentContract(id).stake_currency, 'Custom asset');
    const route = `/api/contracts/${saved.data.contract.id}/close`;
    for (const resultNote of [false, 0, [], {}]) {
      const invalid = await post(id, route, { status: 'completed', resultNote });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.error, t(locale, 'error.contractTextType'));
      assert.equal(getCurrentContract(id).status, 'active');
    }
    const rejected = await post(id, route, { status: 'completed', resultNote: 'Ж'.repeat(501) });
    assert.equal(rejected.status, 400); assert.equal(rejected.data.error, t(locale, 'error.contractResultTooLong'));
    assert.equal(getCurrentContract(id).status, 'active');
    const closed = await post(id, route, { status: 'completed', resultNote: 'Ж'.repeat(500) });
    assert.equal(closed.status, 200); assert.equal(closed.data.contract.result_note, 'Ж'.repeat(500));
  }
});
