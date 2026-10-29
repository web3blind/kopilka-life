const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR,'gemini-ai-'));
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(tmp,'db.sqlite'),AI_WEEKLY_ENABLED:'false',AI_WEEKLY_PAID_ENABLED:'false',AI_WEEKLY_GEMINI_API_KEY:'',AI_WEEKLY_OPENROUTER_API_KEY:'',SCHEDULER_ENABLED:'false'});
const config = require('../src/config');
const provider = require('../src/services/aiWeeklyProvider');
const service = require('../src/services/aiWeeklySummaryService');
const {getDb,initDatabase,closeDb} = require('../src/db');
const realFetch=global.fetch;
test('Gemini visible text tolerates opaque thought signatures without exposing reasoning',async()=>{
 const old={aiWeeklyEnabled:config.aiWeeklyEnabled,aiWeeklyPaidEnabled:config.aiWeeklyPaidEnabled,aiWeeklyGeminiApiKey:config.aiWeeklyGeminiApiKey};
 Object.assign(config,{aiWeeklyEnabled:true,aiWeeklyPaidEnabled:false,aiWeeklyGeminiApiKey:'synthetic-signature-key'});
 const context={period:{start:'2026-10-29',end:'2026-10-29',timezone:'UTC'},selection:{days:1,topic:'summary'}};
 const records=[{date:'2026-10-29',type:'movement',title:'Walk',note:'Fictional walk'}];
 try {
  for(const metadata of [{thoughtSignature:'opaque-encrypted-fixture'},{thought:false,thoughtSignature:'opaque-encrypted-fixture'}]) {
   global.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'A recorded walk.',...metadata}]}}]});
   assert.equal(await provider.generate(records,'en','gemini-3.5-flash-lite',()=>true,context),'A recorded walk.');
  }
  for(const metadata of [{thought:true},{thoughtSignature:{invalid:true}},{functionCall:{name:'unexpected'}}]) {
   global.fetch=async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'Never expose this.',...metadata}]}}]});
   await assert.rejects(provider.generate(records,'en','gemini-3.5-flash-lite',()=>true,context),e=>e.safeCode==='PROVIDER_RESPONSE_INVALID');
  }
 } finally {global.fetch=realFetch;Object.assign(config,old);}
});
const model='gemini-3.5-flash-lite';
function user(locale='en') {
 const id=Number(getDb().prepare('INSERT INTO users(telegram_id,locale,timezone) VALUES(?,?,?)').run('gemini:'+Math.random(),locale,'UTC').lastInsertRowid);
 getDb().prepare("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?,'movement','ignored','untrusted note',2,?)").run(id,service.completedPeriod('UTC').end);return id;
}
function consent(id,topic='summary') {const m=service.read(id,new Date(),{days:7,topic});return {consent:true,consentVersion:m.consentVersion,periodKey:m.period.key,days:7,topic};}
function enable() {Object.assign(config,{aiWeeklyEnabled:true,aiWeeklyPaidEnabled:false,aiWeeklyGeminiApiKey:'synthetic-google-secret',aiWeeklyOpenrouterApiKey:'',aiWeeklyModel:model});}
const ledger=()=>getDb().prepare('SELECT * FROM ai_provider_quota').all();
test('Gemini direct route and durable project admission',async t=>{
 initDatabase();enable();let calls=[];
 global.fetch=async(url,options)=>{calls.push({url,options});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'A recorded walk.'}]}}]});};
 try {
 await t.test('fixed free descriptor, no wrong key or automatic paid fallback',()=>{
  assert.equal(provider.describe().provider,'Google Gemini');assert.equal(config.aiWeeklyModel,model);assert.equal(provider.available(),true);
  config.aiWeeklyGeminiApiKey='';config.aiWeeklyOpenrouterApiKey='wrong-route';assert.equal(provider.available(),false);enable();
 });
 await t.test('actual RU/EN seven-topic payload, no remote countTokens, exact header and conservative input bound',async()=>{
  for(const locale of ['ru','en'])for(const topic of ['summary','calm','hard-days','rest','kindness','self-support','goal']) {
   const id=user(locale);const result=await service.create(id,consent(id,topic));assert.equal(result.summary.status,'ready');assert.equal(result.summary.provider,'Google Gemini');
   const c=calls.at(-1),b=JSON.parse(c.options.body);assert.equal(c.url,`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);assert.equal(c.options.headers['x-goog-api-key'],'synthetic-google-secret');assert.equal(c.options.redirect,'error');
   assert.match(b.systemInstruction.parts[0].text,/untrusted/);assert.match(b.systemInstruction.parts[0].text,locale==='ru'?/in Russian/:/in English/);assert.equal(JSON.parse(b.contents[0].parts[0].text).selection.topic,topic);
   assert.deepEqual(b.generationConfig,{temperature:0.2,maxOutputTokens:1024,thinkingConfig:{thinkingLevel:'minimal'}});
   assert.equal(ledger().at(-1).input_bound,Buffer.byteLength(b.systemInstruction.parts[0].text+b.contents[0].parts[0].text,'utf8')+4096);
  }
 });
 await t.test('15th accepted; 16th project rejection has retry metadata and no weekly slot, duplicate not reserved',async()=>{
  const id=user(),body=consent(id);await service.create(id,body);const n=ledger().length;await service.create(id,body);assert.equal(ledger().length,n);
  const other=user();await assert.rejects(service.create(other,consent(other)),e=>e.safeCode==='AI_PROJECT_QUOTA_EXCEEDED'&&e.status===429&&e.retryAfter>0&&Boolean(e.nextAvailableAt));
  assert.equal(getDb().prepare('SELECT count(*) n FROM ai_weekly_summaries WHERE user_id=?').get(other).n,0);assert.equal(calls.length,15);
 });
 await t.test('old provider consent cannot authorize changed mode; read/delete do not reserve',async()=>{
  const id=user(),body=consent(id),n=ledger().length;config.aiWeeklyPaidEnabled=true;config.aiWeeklyModel='mistralai/mistral-nemo';assert.notEqual(service.read(id).consentVersion,body.consentVersion);await assert.rejects(service.create(id,body),/CONSENT_OR_PERIOD_INVALID/);
  const paidBody=consent(id);config.aiWeeklyModel='another/paid-model';assert.notEqual(service.read(id).consentVersion,paidBody.consentVersion);await assert.rejects(service.create(id,paidBody),/CONSENT_OR_PERIOD_INVALID/);enable();await assert.rejects(service.create(id,paidBody),/CONSENT_OR_PERIOD_INVALID/);service.read(id);assert.equal(ledger().length,n);
 });
 } finally {global.fetch=realFetch;closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
});
