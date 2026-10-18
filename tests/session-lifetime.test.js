const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function scenario(ttl) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kopilka-session-lifetime-'));
  fs.symlinkSync(path.join(root, 'migrations'), path.join(dir, 'migrations'), 'dir');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', SESSION_SECRET: 'isolated-lifetime-fixture', DB_PATH: path.join(dir, 'fixture.sqlite'), SCHEDULER_ENABLED: 'false', DEV_AUTH_ENABLED: 'true' };
  if (ttl !== undefined) env.SESSION_MAX_AGE_SECONDS = String(ttl);
  try {
    return JSON.parse(execFileSync(process.execPath, ['-e', `
      const root=${JSON.stringify(root)};
      const config=require(root+'/src/config');
      const database=require(root+'/src/db');database.initDatabase();
      const user=require(root+'/src/services/usersService').createDemoUser('Lifetime fixture','ru','','UTC');
      const session=require(root+'/src/auth/session');
      const now=Date.now(), token=session.createToken(user.id,now);
      const payload=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());
      const legacyNow=now-8*86400000;
      const currentTTL=config.sessionMaxAgeSeconds;config.sessionMaxAgeSeconds=604800;
      const legacy=session.createToken(user.id,legacyNow);config.sessionMaxAgeSeconds=currentTTL;
      const valid=session.inspectActiveToken(token,now+86400000).status;
      const expires=session.inspectActiveToken(token,payload.exp).status;
      const legacyStatus=session.inspectActiveToken(legacy,now).status;
      database.getDb().prepare('UPDATE users SET session_revision=session_revision+1 WHERE id=?').run(user.id);
      const revoked=session.inspectActiveToken(token,now+1).status;
      console.log(JSON.stringify({ttl:config.sessionMaxAgeSeconds,lifetime:(payload.exp-payload.iat)/1000,valid,expires,legacyStatus,revoked}));database.closeDb();
    `], { cwd: dir, env, encoding: 'utf8' }).trim().split('\n').at(-1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('new default session lasts one year; expiry and revocation remain enforced', () => {
  const r=scenario();assert.equal(r.ttl,31536000);assert.equal(r.lifetime,31536000);
  assert.equal(r.valid,'valid');assert.equal(r.expires,'expired');assert.equal(r.revoked,'invalid');
  assert.equal(r.legacyStatus,'expired','old seven-day tokens are not silently resurrected');
});
test('explicit short-lived session configuration is still honored', () => {
  const r=scenario(3600);assert.equal(r.ttl,3600);assert.equal(r.lifetime,3600);assert.equal(r.expires,'expired');assert.equal(r.revoked,'invalid');
});
