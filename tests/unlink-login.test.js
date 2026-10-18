const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initDatabase, closeDb, getDb } = require('../src/db');
const { upsertVkUser } = require('../src/services/usersService');
const { loginIdentityStatus, unlinkLoginIdentities } = require('../src/services/loginIdentityService');
const { resolveGoogleUser } = require('../src/services/googleAuthService');

test('atomic email+Google unlink keeps VK account, existing data, and blocks last login removal', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'unlink-login-'));
  initDatabase(path.join(dir, 'test.sqlite'));
  try {
    const db = getDb();
    const vk = upsertVkUser('900900', '', 'UTC');
    db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email','test@gmail.com',?)").run(vk.id);
    const profile = { sub: 'google-test-sub', email: 'test@gmail.com', email_verified: true };
    assert.equal(resolveGoogleUser(profile, { user_id: vk.id }).id, vk.id);
    assert.deepEqual(loginIdentityStatus(vk.id), { email: true, google: true });
    db.prepare("INSERT INTO entries (user_id, type, title, life_points, entry_date) VALUES (?, 'test', 'Retained', 1, '2026-09-27')").run(vk.id);
    db.prepare("INSERT INTO email_login_codes (email,code_hash,expires_at,attempts,sent_at,window_start,window_count,requested_by) VALUES ('test@gmail.com','x',1,0,1,1,1,?)").run(vk.id);
    db.prepare("INSERT INTO google_oauth_states (state_hash,browser_hash,nonce,code_verifier,user_id,expires_at) VALUES ('hash','browser','nonce','verifier',?,9999999999)").run(vk.id);
    assert.equal(unlinkLoginIdentities(vk.id).removed, 2);
    assert.deepEqual(loginIdentityStatus(vk.id), { email: false, google: false });
    assert.equal(db.prepare('SELECT vk_id FROM users WHERE id=?').get(vk.id).vk_id, '900900');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE user_id=?').get(vk.id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM email_login_codes WHERE requested_by=?').get(vk.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM google_oauth_states WHERE user_id=?').get(vk.id).n, 0);
    const emailOnly = db.prepare("INSERT INTO users (telegram_id,first_name) VALUES ('email:synthetic','Only')").run().lastInsertRowid;
    db.prepare("INSERT INTO login_identities (provider,subject,user_id) VALUES ('email','only@example.com',?)").run(emailOnly);
    assert.throws(() => unlinkLoginIdentities(emailOnly), /VK или Telegram/);
    assert.deepEqual(loginIdentityStatus(emailOnly), { email: true, google: false });
  } finally { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); }
});
