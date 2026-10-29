const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'gemini-http-'));
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(tmp,'db.sqlite'),SESSION_SECRET:'gemini-http-synthetic-secret',AI_WEEKLY_ENABLED:'false',AI_WEEKLY_PAID_ENABLED:'false',AI_WEEKLY_GEMINI_API_KEY:'',AI_WEEKLY_OPENROUTER_API_KEY:'',SCHEDULER_ENABLED:'false'});
const config=require('../src/config');
const {getDb,initDatabase,closeDb}=require('../src/db');
const service=require('../src/services/aiWeeklySummaryService');
const provider=require('../src/services/aiWeeklyProvider');
const {createToken,inspectActiveToken}=require('../src/auth/session');
const {moveRecords}=require('../src/services/mergeRecords');
const realFetch=global.fetch;
const valid=()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'A recorded walk.'}]}}]});
const count=()=>getDb().prepare('SELECT count(*) n FROM ai_provider_quota').get().n;
const claims=id=>getDb().prepare('SELECT count(*) n FROM ai_weekly_summaries WHERE user_id=?').get(id).n;
function user(note='PRIVATE synthetic note') {
 const id=Number(getDb().prepare('INSERT INTO users(telegram_id,locale,timezone) VALUES(?,?,?)').run('ghttp:'+Math.random(),'en','UTC').lastInsertRowid);
 if(note!==null)getDb().prepare("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?,'movement','ignore',?,2,?)").run(id,note,service.completedPeriod('UTC').end);return id;
}
function enable() {Object.assign(config,{aiWeeklyEnabled:true,aiWeeklyPaidEnabled:false,aiWeeklyGeminiApiKey:'synthetic-secret-not-for-logs',aiWeeklyOpenrouterApiKey:'',aiWeeklyTimeoutMs:1000});}
test('Gemini real HTTP tempSQLite admission, errors, privacy and authorization fences',async t=>{
 initDatabase();enable();let calls=[],handler=()=>Response.json(valid());
 global.fetch=async(url,options)=>{assert.match(url,/^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);calls.push({url,options});return handler(url,options);};
 const app=require('express')();app.use(require('express').json());
 app.use('/ai-weekly-summary',(req,res,next)=>{const a=inspectActiveToken((req.get('authorization')||'').replace(/^Bearer\s+/,''));if(a.status!=='valid')return res.sendStatus(401);req.user=getDb().prepare('SELECT * FROM users WHERE id=?').get(a.userId);next();},require('../src/routes/aiWeeklySummary'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;config.appBaseUrl=base;
 const request=async(id,method='GET',body,suffix='',token=createToken(id))=>{const r=await realFetch(base+'/ai-weekly-summary'+suffix,{method,headers:{Origin:base,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,headers:r.headers,body:await r.json()};};
 const consent=async id=>{const m=(await request(id)).body;return {consent:true,consentVersion:m.consentVersion,periodKey:m.period.key,days:7,topic:'summary'};};
 const reset=()=>{getDb().exec('DELETE FROM ai_provider_quota');calls=[];handler=()=>Response.json(valid());enable();};
 try {
 await t.test('missing key/master, invalid/no consent/oversize/empty cause no reservation or user claim',async()=>{
  for(const mode of ['key','master','consent','old-or-consent','oversize','empty','invalid']) {
   reset();const id=user(mode==='empty'?null:mode==='oversize'?'x'.repeat(25000):'note'),body=await consent(id);
   if(mode==='key')config.aiWeeklyGeminiApiKey='';if(mode==='master')config.aiWeeklyEnabled=false;if(mode==='consent')body.consent=false;if(mode==='old-or-consent')body.consentVersion='2026-10-29';if(mode==='invalid')body.days=31;
   const r=await request(id,'POST',body);assert.equal(r.status,['key','master'].includes(mode)?503:mode==='empty'?200:400,mode);assert.equal(claims(id),0);assert.equal(count(),0);assert.equal(calls.length,0);
  }
 });
 await t.test('15 parallel distinct users admitted before awaited fetch; 16th 429 metadata no weekly slot; duplicate one reservation',async()=>{
  reset();const releases=[];handler=()=>new Promise(resolve=>releases.push(()=>resolve(Response.json(valid()))));
  const ids=Array.from({length:16},()=>user()),bodies=await Promise.all(ids.map(consent));
  const pending=ids.slice(0,15).map((id,i)=>request(id,'POST',bodies[i]));
  while(releases.length<15)await new Promise(r=>setTimeout(r,1));
  try {
   assert.equal(count(),15);const duplicate=await request(ids[0],'POST',bodies[0]);assert.equal(duplicate.body.summary.status,'processing');assert.equal(count(),15);
   const rejected=await request(ids[15],'POST',bodies[15]);assert.equal(rejected.status,429);assert.equal(rejected.body.code,'AI_PROJECT_QUOTA_EXCEEDED');assert.equal(rejected.headers.get('retry-after'),String(rejected.body.retryAfter));assert.equal(rejected.body.projectQuota.allowed,false);assert.ok(Date.parse(rejected.body.nextAvailableAt)>Date.now());assert.equal(claims(ids[15]),0);
   assert.equal((await request(ids[15])).body.quota.allowed,true);assert.equal((await request(ids[15])).body.projectQuota.allowed,false);
  } finally {for(const release of releases)release();}
  for(const r of await Promise.all(pending))assert.equal(r.body.summary.status,'ready');assert.equal(calls.length,15);
 });
 await t.test('rollback both reservation/claim when either insert fails',async()=>{
  reset();const id=user(),body=await consent(id);
  getDb().exec("CREATE TRIGGER test_claim_fail BEFORE INSERT ON ai_weekly_summaries BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try {assert.equal((await request(id,'POST',body)).status,503);assert.equal(count(),0);assert.equal(claims(id),0);assert.equal(calls.length,0);}finally {getDb().exec('DROP TRIGGER test_claim_fail');}
  getDb().exec("CREATE TRIGGER test_project_fail BEFORE INSERT ON ai_provider_quota BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try {assert.equal((await request(id,'POST',body)).status,503);assert.equal(count(),0);assert.equal(claims(id),0);assert.equal(calls.length,0);}finally {getDb().exec('DROP TRIGGER test_project_fail');}
 });
 await t.test('upstream429 busy consumes claim once; failures/uncertainties retained; no raw error/key output',async()=>{
  const cases=[
   ['busy',()=>Response.json({error:{message:'synthetic-secret-not-for-logs PRIVATE synthetic note'}},{status:429}),'PROVIDER_BUSY','failed'],
   ['server',()=>Response.json({}, {status:500}),'PROVIDER_UNCERTAIN','uncertain'],
   ['timeout',(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('synthetic-secret-not-for-logs')))),'PROVIDER_UNCERTAIN','uncertain'],
   ['json',()=>new Response('broken'),'PROVIDER_RESPONSE_INVALID','uncertain'],
   ['null',()=>Response.json(null),'PROVIDER_RESPONSE_INVALID','uncertain'],
   ['huge',()=>new Response('x'.repeat(512*1024+1)),'PROVIDER_RESPONSE_INVALID','uncertain'],
   ...['MAX_TOKENS','SAFETY','RECITATION','OTHER',undefined].map(reason=>['finish',()=>Response.json({candidates:[{finishReason:reason,content:{parts:[{text:'partial'}]}}]}),'PROVIDER_RESPONSE_INVALID','uncertain']),
   ...[[{text:'thought',thought:true}],[{functionCall:{name:'tool'}}],[{text:'ok',thoughtSignature:{invalid:true}}],[{text:'<b>HTML</b>'}],[{text:'x'.repeat(2001)}],[{text:'bad\u0001'}],[{text:' '}],[]].map(parts=>['parts',()=>Response.json({candidates:[{finishReason:'STOP',content:{parts}}]}),'PROVIDER_RESPONSE_INVALID','uncertain']),
   ['blocked',()=>Response.json({promptFeedback:{blockReason:'SAFETY'},...valid()}),'PROVIDER_RESPONSE_INVALID','uncertain'],
   ['safety',()=>{const r=valid();r.candidates[0].safetyRatings=[{blocked:true}];return Response.json(r);},'PROVIDER_RESPONSE_INVALID','uncertain']
  ];
  for(const [name,fn,code,status] of cases) {
   reset();handler=fn;config.aiWeeklyTimeoutMs=50;const id=user(),body=await consent(id);const r=await request(id,'POST',body);assert.equal(r.body.summary.errorCode,code,name);assert.equal(r.body.summary.status,status,name);assert.equal(count(),1);assert.equal(claims(id),1);assert.equal(r.body.quota.allowed,false);assert.doesNotMatch(JSON.stringify(r.body),/synthetic-secret-not-for-logs|PRIVATE synthetic note/);
   await request(id);await request(id,'POST',body);assert.equal(calls.length,1);assert.equal(count(),1);
  }
 });
 await t.test('opaque Gemini signature never reaches saved text or API archive',async()=>{
  reset();handler=()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'A recorded walk.',thoughtSignature:'opaque-signature-never-save'}]}}]});
  const id=user(),r=await request(id,'POST',await consent(id));assert.equal(r.status,200);assert.equal(r.body.summary.status,'ready');assert.equal(r.body.summary.text,'A recorded walk.');
  const saved=getDb().prepare('SELECT text FROM ai_weekly_summaries WHERE user_id=?').get(id);assert.equal(saved.text,'A recorded walk.');
  const reread=await request(id);assert.doesNotMatch(JSON.stringify(reread.body),/opaque-signature-never-save|thoughtSignature/);assert.equal(calls.length,1);
 });
 await t.test('preSend revoked owner never sends; postSend revision change never returns or archives private output',async()=>{
  reset();let checks=0;const denied=user();await assert.rejects(service.create(denied,await consent(denied),()=>false),e=>e.safeCode==='SESSION_INVALID');assert.equal(calls.length,0);assert.equal(count(),0);assert.equal(claims(denied),0);
  const ctx={period:{start:'2026-10-29',end:'2026-10-29'},selection:{days:1,topic:'summary'}};
  await assert.rejects(provider.generate([], 'en',config.aiWeeklyModel,()=>{checks++;return false;},ctx),e=>e.safeCode==='REQUEST_CANCELLED');assert.equal(checks,1);assert.equal(calls.length,0);
  const id=user(),body=await consent(id);let release;handler=()=>new Promise(resolve=>{release=()=>resolve(Response.json(valid()));});const pending=request(id,'POST',body);
  while(!release)await new Promise(r=>setTimeout(r,1));getDb().prepare('UPDATE users SET session_revision=session_revision+1 WHERE id=?').run(id);release();const r=await pending;assert.equal(r.status,401);assert.equal(count(),1);assert.equal(service.read(id).archive.length,0);assert.equal(service.read(id).summary.errorCode,'REQUEST_CANCELLED');
 });
 await t.test('merge/delete/archive reads preserve global ledger and historical provider; restart retains both',async()=>{
  reset();const a=user(),b=user();const one=await request(a,'POST',await consent(a));await request(b,'POST',await consent(b));const before=getDb().prepare('SELECT * FROM ai_provider_quota').all();
  getDb().transaction(()=>moveRecords(getDb(),a,b))();assert.equal(service.read(a).quota.allowed,false);assert.equal(service.read(a).archive.length,2);
  const history=service.read(a).archive;assert.ok(history.every(row=>row.provider==='Google Gemini'&&row.model==='gemini-3.5-flash-lite'));
  await request(a,'DELETE',undefined,'/'+one.body.summary.id);getDb().prepare('DELETE FROM users WHERE id=?').run(a);getDb().prepare('DELETE FROM users WHERE id=?').run(b);
  assert.deepEqual(getDb().prepare('SELECT * FROM ai_provider_quota').all(),before);closeDb();initDatabase();assert.deepEqual(getDb().prepare('SELECT * FROM ai_provider_quota').all(),before);assert.equal(calls.length,2);
 });
 await t.test('expired identical period no longer blocks new generation, legacy archive text untouched',async()=>{
  reset();const id=user(),body=await consent(id);const first=await request(id,'POST',body);getDb().prepare('UPDATE ai_weekly_summaries SET started_at=? WHERE id=?').run(Date.now()-168*3600000,first.body.summary.id);
  const second=await request(id,'POST',body);assert.notEqual(second.body.summary.id,first.body.summary.id);assert.equal(second.body.archive.length,2);assert.equal(count(),2);
 });
 } finally {global.fetch=realFetch;await new Promise(r=>server.close(r));closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
});
