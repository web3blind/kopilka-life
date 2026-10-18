const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDatabase, closeDb, getDb } = require('../src/db');
const { upsertTelegramUser } = require('../src/services/usersService');
const { requestEmailCode, verifyEmailCode } = require('../src/services/emailAuthService');

test('email code is single-use, rate-limited and links without moving existing records', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kopilka-auth-'));
  initDatabase(path.join(dir, 'test.sqlite'));
  let code, sent = 0;
  const sender = async (address, value) => { assert.equal(address, 'one@example.com'); code = value; sent++; };
  try {
    const original = upsertTelegramUser({ id: 4321, first_name: 'Existing', username: '' });
    await requestEmailCode({ email: ' ONE@example.com ', requestedBy: original.id, sender });
    assert.equal(sent, 1);
    await requestEmailCode({ email: 'one@example.com', requestedBy: original.id, sender });
    assert.equal(sent, 1, 'resend cooldown');
    assert.equal(verifyEmailCode({ email: 'one@example.com', code: code === '999999' ? '000000' : '999999', requestedBy: original.id }), null);
    const linked = verifyEmailCode({ email: 'one@example.com', code, requestedBy: original.id });
    assert.equal(linked.id, original.id);
    assert.equal(getDb().prepare("SELECT user_id FROM login_identities WHERE provider = 'email'").get().user_id, original.id);
    assert.throws(() => verifyEmailCode({ email: 'one@example.com', code, requestedBy: original.id }), /код/);
    getDb().prepare('UPDATE email_login_codes SET sent_at = sent_at - 61 WHERE email = ?').run('one@example.com');
    await requestEmailCode({ email: 'one@example.com', sender });
    assert.equal(verifyEmailCode({ email: 'one@example.com', code }).id, original.id);
  } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
});
