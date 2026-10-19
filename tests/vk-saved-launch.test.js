'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const express = require('express');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-saved-launch-'));
const cp = require.resolve('../src/config');
const config = { nodeEnv:'test', isProduction:false, dbPath:path.join(tmp,'qa.sqlite'), sessionSecret:'fixture-only', sessionMaxAgeSeconds:600,
  vkSecureKey:'fixture-vk-key', vkAppId:'54723764', vkAuthMaxAgeSeconds:86400, vkGroupToken:'',
  rateLimits:{authWindowMs:60000,authMax:200,storyWindowMs:60000,storyMax:200,devWindowMs:60000,devMax:200} };
require.cache[cp] = {id:cp,filename:cp,loaded:true,exports:config};
const originalFetch = global.fetch;
global.fetch = (url, options) => { assert.match(String(url), /^http:\/\/127\.0\.0\.1:/, 'no outbound network'); return originalFetch(url,options); };
const {getDb,closeDb} = require('../src/db');
const {upsertVkUser} = require('../src/services/usersService');
const {createToken} = require('../src/auth/session');
const router = require('../src/routes/api');
function launch(id, age=172800, app='54723764') {
  const params = new URLSearchParams({vk_app_id:app,vk_user_id:String(id),vk_ts:String(Math.floor(Date.now()/1000)-age),vk_language:'ru'});
  const check = [...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('&');
  params.set('sign',crypto.createHmac('sha256',config.vkSecureKey).update(check).digest('base64url')); return params.toString();
}
test('stale signed launch resumes only same active identity, without renewal or writes; fresh launch keeps priority', async()=>{
  const a=upsertVkUser('91001'), b=upsertVkUser('91002');
  const token=createToken(a.id), other=createToken(b.id), expired=createToken(a.id,Date.now()-700000);
  const app=express();app.use(express.json());app.use('/api',router);
  const s=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${s.address().port}`;
  const post=async(proof,bearer=token,route='/api/auth/vk/resume')=>{
    const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bearer},body:JSON.stringify({launchParams:proof})});return {status:r.status,body:r.headers.get('content-type')?.includes('json') ? await r.json() : {}};
  };
  const snapshot=()=>JSON.stringify(getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,getDb().prepare(`SELECT * FROM "${name}"`).all()]));
  try {
    const before=snapshot();
    const ok=await post(launch('91001'));assert.equal(ok.status,200);assert.equal(ok.body.token,token);assert.equal(ok.body.user.id,a.id);assert.equal(snapshot(),before);
    for(const [proof,bearer] of [[launch('91002'),token],[launch('91001'),other],[launch('91001'),''],[launch('91001'),expired],[launch('91001')+'x',token],[launch('91001',172800,'999'),token],[launch('91001',-600),token],[launch('91001',0),token],[launch('91999'),token]]) {
      const r=await post(proof,bearer);assert.equal(r.status,401);assert.equal(r.body.user,undefined);assert.equal(r.body.token,undefined);assert.equal(snapshot(),before);
    }
    assert.equal((await post(launch('91001'),token,'/api/auth/vk')).status,401,'new login remains strict');
    const fresh=await post(launch('91002',0),token,'/api/auth/vk');assert.equal(fresh.status,200);assert.equal(fresh.body.user.id,b.id,'fresh B beats cached A');
    getDb().prepare('UPDATE users SET session_revision=session_revision+1 WHERE id=?').run(a.id);
    assert.equal((await post(launch('91001'))).status,401,'revoked token rejected');
    const updated=createToken(a.id);getDb().prepare('UPDATE users SET vk_id=? WHERE id=?').run('91998',a.id);
    assert.equal((await post(launch('91001'),updated)).status,401,'current DB identity required');
  } finally { await new Promise(resolve=>s.close(resolve));closeDb();fs.rmSync(tmp,{recursive:true,force:true});global.fetch=originalFetch; }
});
