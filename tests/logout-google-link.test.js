const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-google-'));
Object.assign(process.env, { NODE_ENV:'test', DB_PATH:path.join(tmp,'qa.sqlite'), SCHEDULER_ENABLED:'false', BOT_TOKEN:'', VK_GROUP_TOKEN:'', RESEND_API_KEY:'', GOOGLE_CLIENT_ID:'fixture-google', GOOGLE_CLIENT_SECRET:'fixture-secret', APP_BASE_URL:'http://127.0.0.1:3333', WEBAPP_URL:'http://127.0.0.1:3333', SESSION_SECRET:'fixture-session-secret' });
const { getDb, closeDb } = require('../src/db');
const { createToken, revokeToken } = require('../src/auth/session');
const service = require('../src/services/googleAuthService');

test('logout invalidates pending Google link at authorize and callback but not independent session',()=>{
  try {
    const db=getDb();
    const id=Number(db.prepare("INSERT INTO users(telegram_id,first_name) VALUES('logout-google-fixture','Fixture')").run().lastInsertRowid);
    const first=createToken(id), independent=createToken(id);
    const before=service.createGoogleIntent({userId:id,session:first});
    const after=service.createGoogleIntent({userId:id,session:first});
    const valid=service.createGoogleIntent({userId:id,session:independent});
    const intent=p=>new URL(p.launchUrl).searchParams.get('intent');
    const browser='fixture-browser-binding-'.repeat(3);
    const authUrl=service.beginGoogleIntent(intent(after),browser);
    const context=service.consumeGoogleState(new URL(authUrl).searchParams.get('state'),browser);
    assert.equal(revokeToken(first).status,'revoked');
    assert.throws(()=>service.beginGoogleIntent(intent(before),browser),/revoked/);
    assert.throws(()=>service.resolveGoogleUser({sub:'fixture-google-sub',email:'fixture@invalid.test',email_verified:true},context),/revoked/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM login_identities WHERE user_id=?').get(id).n,0);
    const validUrl=service.beginGoogleIntent(intent(valid),browser);
    const validContext=service.consumeGoogleState(new URL(validUrl).searchParams.get('state'),browser);
    assert.equal(service.resolveGoogleUser({sub:'independent-google-sub',email:'fixture@invalid.test',email_verified:true},validContext).id,id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM login_identities WHERE user_id=? AND provider='google'").get(id).n,1);
  } finally { closeDb();fs.rmSync(tmp,{recursive:true,force:true}); }
});
