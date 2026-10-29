const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'weekly-mode-'));
Object.assign(process.env, { NODE_ENV:'test', DB_PATH:path.join(dir,'db.sqlite'), AI_WEEKLY_ENABLED:'false', AI_WEEKLY_PAID_ENABLED:'false', AI_WEEKLY_MODEL:'fixture/free:free', AI_WEEKLY_OPENROUTER_API_KEY:'', AI_WEEKLY_GEMINI_API_KEY:'', SCHEDULER_ENABLED:'false' });
const config = require('../src/config');
const { initDatabase, getDb, closeDb } = require('../src/db');
const { createToken, inspectActiveToken } = require('../src/auth/session');
const service = require('../src/services/aiWeeklySummaryService');
const realFetch = global.fetch;
const paidModel = 'mistralai/mistral-nemo';
const freeModel = 'fixture/free:free';
let calls, prices, endpointPrices, privatePrices, noendpoint, privacy, architecture, reject, extraEndpoints;
function reset(paid = true, model = paidModel) {
  Object.assign(config, { aiWeeklyEnabled:true, aiWeeklyPaidEnabled:paid, aiWeeklyModel:model, aiWeeklyOpenrouterApiKey:'fixture-key' });
  calls=[]; prices={prompt:'0.0000001',completion:'0.0000004',request:'0'};
  if(model.endsWith(':free')) prices={prompt:'0',completion:'0'};
  endpointPrices={...prices}; privatePrices={...prices}; noendpoint=false; privacy=false; reject=false;
  architecture={input_modalities:['text'],output_modalities:['text']}; extraEndpoints=[];
}
function fixture(url, options={}) {
  calls.push({url, options});
  const model=config.aiWeeklyModel;
  if(url==='https://openrouter.ai/api/v1/models')return Promise.resolve(Response.json({data:[{id:model,pricing:prices,architecture}]}));
  if(url===`https://openrouter.ai/api/v1/models/${model}/endpoints`)return Promise.resolve(Response.json({data:{endpoints:noendpoint?[]:[{tag:'eligible',pricing:endpointPrices},{tag:'expensive',pricing:{prompt:'1',completion:'1'}},...extraEndpoints]}}));
  if(url==='https://openrouter.ai/api/v1/endpoints/zdr')return Promise.resolve(Response.json({data:privacy?[]:[{model_id:model,tag:'eligible',pricing:privatePrices},{model_id:model,tag:'expensive',pricing:{prompt:'1',completion:'1'}},...extraEndpoints.map(row=>({...row,model_id:model}))]}));
  assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
  if(reject)return Promise.resolve(Response.json({error:{}},{status:429}));
  const body=JSON.parse(options.body);
  return Promise.resolve(Response.json({choices:[{finish_reason:'stop',message:{content:body.messages[0].content.includes('in Russian')?'Записана прогулка.':'A walk was recorded.'}}]}));
}

test('isolated config defaults and exact paid opt-in, no working .env',()=>{
  const file=require.resolve('../src/config');
  for(const [flag,model,override] of [[undefined,'gemini-3.5-flash-lite'],['false','gemini-3.5-flash-lite'],['TRUE','gemini-3.5-flash-lite'],['true',paidModel],['true',freeModel,freeModel],['false','gemini-3.5-flash-lite',paidModel]]) {
    const env={ PATH:process.env.PATH, NODE_ENV:'test', AI_WEEKLY_ENABLED:'true', AI_WEEKLY_OPENROUTER_API_KEY:'fixture-key' };
    if(override)env.AI_WEEKLY_MODEL=override;
    if(flag!==undefined)env.AI_WEEKLY_PAID_ENABLED=flag;
    const child=spawnSync(process.execPath,['-e',`const c=require(${JSON.stringify(file)});console.log(JSON.stringify([c.aiWeeklyModel,c.aiWeeklyPaidEnabled,c.aiWeeklyEnabled]))`],{cwd:dir,env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    const values=JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.deepEqual(values,[flag==='true' ? (override || model) : 'gemini-3.5-flash-lite',flag==='true',true]);
  }
});

test('paid/free HTTP mode, strict catalogs, locales and durable anti-resend',async t=>{
  initDatabase();
  const app=require('express')();app.use(require('express').json());
  app.use('/ai-weekly-summary',(req,res,next)=>{
    const auth=inspectActiveToken((req.get('authorization')||'').replace(/^Bearer\s+/i,''));
    if(auth.status!=='valid')return res.sendStatus(401);
    req.user=getDb().prepare('SELECT * FROM users WHERE id=?').get(auth.userId);next();
  },require('../src/routes/aiWeeklySummary'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;config.appBaseUrl=base;global.fetch=fixture;
  const user=(locale='en')=>{
    const id=Number(getDb().prepare('INSERT INTO users(telegram_id,locale,timezone) VALUES(?,?,?)').run('mode:'+Math.random(),locale,'UTC').lastInsertRowid);
    getDb().prepare("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?,'movement','unused','walk',2,?)").run(id,service.completedPeriod('UTC').start);return id;
  };
  const request=async(id,method='GET')=>{
    const response=await realFetch(base+'/ai-weekly-summary',{method,headers:{Origin:base,Authorization:'Bearer '+createToken(id),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({consent:true,consentVersion:service.read(id).consentVersion,periodKey:service.completedPeriod('UTC').key,days:7,topic:'summary'})}:{})});
    return {status:response.status,body:await response.json()};
  };
  const posts=()=>calls.filter(c=>c.options.method==='POST');
  try {
    await t.test('key alone never enables paid; missing key or master switch disables either mode',async()=>{
      for(const paid of [false,true])for(const missing of ['key','enabled']) {
        reset(paid,paid?paidModel:freeModel);if(missing==='key')config.aiWeeklyOpenrouterApiKey='';else config.aiWeeklyEnabled=false;
        const id=user();assert.equal((await request(id)).body.available,false);assert.equal((await request(id,'POST')).status,503);assert.equal(calls.length,0);
      }
      reset(false);const id=user();const g=await request(id);assert.equal(g.body.available,false);assert.equal(g.body.paidMode,false);assert.equal((await request(id,'POST')).status,503);assert.equal(calls.length,0);
    });
    await t.test('explicit OpenRouter mode permits zero-priced model overrides but never paid fallback',async()=>{
      for(const paid of [true]) {
        reset(paid,freeModel);const id=user();const r=await request(id,'POST');assert.equal(r.body.summary.status,'ready');assert.equal(r.body.paidMode,paid);
        assert.deepEqual(JSON.parse(posts()[0].options.body).provider.max_price,{prompt:0,completion:0});
        reset(paid,freeModel);prices.prompt='0.0000001';const failed=await request(user(),'POST');assert.equal(failed.body.summary.errorCode,'FREE_MODEL_REQUIRED');assert.equal(posts().length,0);
        reset(paid,freeModel);reject=true;const rejected=await request(user(),'POST');assert.equal(rejected.body.summary.status,'failed');assert.equal(posts().length,1);assert.equal(JSON.parse(posts()[0].options.body).model,freeModel);
      }
    });
    await t.test('actual RU/EN prompts, fixed router USD/M caps, exact saved model/locale after switch',async()=>{
      for(const locale of ['ru','en']) {
        reset();const id=user(locale);const r=await request(id,'POST');assert.equal(r.body.summary.status,'ready');assert.equal(r.body.paidMode,true);
        const body=JSON.parse(posts()[0].options.body);assert.equal(body.model,paidModel);assert.match(body.messages[0].content,locale==='ru'?/in Russian/:/in English/);
        assert.deepEqual(body.provider,{only:['eligible'],allow_fallbacks:false,data_collection:'deny',zdr:true,max_price:{prompt:0.10,completion:0.40,request:0}});
        const row=getDb().prepare('SELECT model,locale,text FROM ai_weekly_summaries WHERE id=?').get(r.body.summary.id);assert.equal(row.model,paidModel);assert.equal(row.locale,locale);
        getDb().prepare('UPDATE users SET locale=? WHERE id=?').run(locale==='ru'?'en':'ru',id);config.aiWeeklyModel=freeModel;config.aiWeeklyPaidEnabled=false;
        const before=calls.length;for(const method of ['GET','POST']) {const saved=await request(id,method);assert.equal(saved.body.summary.text,row.text);assert.equal(saved.body.summary.locale,locale);}
        assert.equal(calls.length,before);assert.deepEqual(getDb().prepare('SELECT model,locale,text FROM ai_weekly_summaries WHERE id=?').get(r.body.summary.id),row);
      }
    });
    await t.test('paid chooses a single cheapest private endpoint and locks its quoted prices',async()=>{
      reset();endpointPrices={prompt:'0.00000005',completion:'0.0000002'};privatePrices={...endpointPrices};
      extraEndpoints=[{tag:'cheapest',pricing:{prompt:'0.00000002',completion:'0.00000003'}}];
      const response=await request(user(),'POST');assert.equal(response.body.summary.status,'ready');
      const body=JSON.parse(posts()[0].options.body);
      assert.deepEqual(body.provider.only,['cheapest']);assert.equal(body.provider.allow_fallbacks,false);
      assert.deepEqual(body.provider.max_price,{prompt:0.02,completion:0.03,request:0});
    });
    await t.test('all three price sources fail closed on cap increases, invalid/missing prices and extras',async()=>{
      const invalid=[undefined,null,{}, {prompt:'0.00000010001',completion:'0'}, {prompt:'0',completion:'0.00000040001'}, {prompt:'NaN',completion:'0'}, {prompt:'Infinity',completion:'0'}, {prompt:'-0.1',completion:'0'}, {prompt:'',completion:'0'}, {prompt:'0',completion:'0',request:'0.001'}, {prompt:'0',completion:'0',future_fee:'0.1'}, {prompt:'0',completion:'0',image:null}];
      for(const source of ['model','endpoint','zdr'])for(const bad of invalid) {
        reset();if(source==='model')prices=bad;else if(source==='endpoint')endpointPrices=bad;else privatePrices=bad;
        const id=user();const r=await request(id,'POST');assert.equal(r.body.summary.status,'failed',source+JSON.stringify(bad));assert.equal(r.body.summary.errorCode,'PRICE_LIMIT_EXCEEDED');assert.equal(posts().length,0);
        const before=calls.length;await request(id,'POST');assert.equal(calls.length,before);
      }
    });
    await t.test('missing text metadata, endpoint and ZDR policy fail closed',async()=>{
      for(const reason of ['architecture','endpoint','privacy']) {
        reset();if(reason==='architecture')architecture=undefined;if(reason==='endpoint')noendpoint=true;if(reason==='privacy')privacy=true;
        const r=await request(user(),'POST');assert.equal(r.body.summary.status,'failed');assert.equal(r.body.summary.errorCode,reason==='architecture'?'MODEL_VERIFICATION_FAILED':'PRIVATE_ENDPOINT_UNAVAILABLE');assert.equal(posts().length,0);
      }
    });
  } finally { global.fetch=realFetch;await new Promise(r=>server.close(r));closeDb();fs.rmSync(dir,{recursive:true,force:true}); }
});
