const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');
const quota=require('../src/services/aiProviderQuota');
const {applyMigration}=require('../src/db');
const sql=fs.readFileSync('migrations/026_ai_provider_quota.sql','utf8');
function database() {const db=new Database(':memory:');db.exec(sql);return db;}
const stamp=Date.parse('2026-10-29T18:00:00Z');
const reserve=(db,now,tokens)=>db.transaction(()=>quota.reserve(db,now,tokens)).immediate();
test('project RPM exact 60s boundary, accurate token relief and combined constraints',()=>{
 const db=database();try {
  for(let i=0;i<15;i++)reserve(db,stamp+i,1000);
  assert.equal(quota.inspect(db,stamp+15).allowed,false);
  assert.equal(quota.inspect(db,stamp+59999).nextAvailableAt,new Date(stamp+60000).toISOString());
  assert.equal(quota.inspect(db,stamp+60000).allowed,true);
  db.exec('DELETE FROM ai_provider_quota');
  reserve(db,stamp,100000);reserve(db,stamp+1000,100000);reserve(db,stamp+2000,50000);
  assert.equal(quota.inspect(db,stamp+2000,1).allowed,false);
  assert.equal(quota.inspect(db,stamp+2000,150001).nextAvailableAt,new Date(stamp+61000).toISOString());
  assert.throws(()=>reserve(db,stamp+2000,1),/AI_PROJECT_QUOTA_EXCEEDED/);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_provider_quota').get().n,3);
  assert.equal(quota.inspect(db,stamp+60000,100000).allowed,true);
 } finally {db.close();}
});
test('Pacific day boundaries include DST 23h/25h days; daily 500 and max needed relief',()=>{
 const db=database();try {
  for(const [now,start,end] of [
   ['2026-03-08T12:00:00Z','2026-03-08T08:00:00Z','2026-03-09T07:00:00Z'],
   ['2026-11-01T12:00:00Z','2026-11-01T07:00:00Z','2026-11-02T08:00:00Z'],
   ['2026-03-09T07:00:00Z','2026-03-09T07:00:00Z','2026-03-10T07:00:00Z']])assert.deepEqual(quota.dayWindow(Date.parse(now)),{start:Date.parse(start),end:Date.parse(end)});
  const day=quota.dayWindow(stamp), insert=db.prepare('INSERT INTO ai_provider_quota(reserved_at,input_bound) VALUES(?,1)');
  db.transaction(()=>{for(let i=0;i<499;i++)insert.run(day.start+i);})();
  reserve(db,stamp,1);assert.equal(quota.inspect(db,stamp).nextAvailableAt,new Date(day.end).toISOString());
  assert.equal(quota.inspect(db,day.end).allowed,true);
  db.exec('DELETE FROM ai_provider_quota');
  db.transaction(()=>{for(let i=0;i<500;i++)insert.run(day.end-30000);})();
  assert.equal(quota.inspect(db,day.end-1000).nextAvailableAt,new Date(day.end+30000).toISOString());
  assert.equal(quota.inspect(db,day.end+29999).allowed,false);assert.equal(quota.inspect(db,day.end+30000).allowed,true);
 } finally {db.close();}
});
test('future local clock fails closed; global ledger stable across key/model/restart and no user FK',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'quota-restart-')),file=path.join(dir,'db.sqlite');let db=new Database(file);try {
  db.exec(sql);reserve(db,stamp+60000,1000);assert.equal(quota.inspect(db,stamp).allowed,false);assert.equal(quota.inspect(db,stamp).nextAvailableAt,new Date(stamp+60000).toISOString());assert.equal(quota.inspect(db,stamp+60000).allowed,true);
  const rows=db.prepare('SELECT * FROM ai_provider_quota').all();db.close();db=new Database(file);db.exec(sql);assert.deepEqual(db.prepare('SELECT * FROM ai_provider_quota').all(),rows);
  const child=spawnSync(process.execPath,['-e',`const D=require('better-sqlite3');const q=require('./src/services/aiProviderQuota');const d=new D(process.argv[1]);console.log(JSON.stringify(q.inspect(d,${stamp})))`,file],{encoding:'utf8',env:{...process.env,AI_WEEKLY_GEMINI_API_KEY:'rotated-synthetic',AI_WEEKLY_MODEL:'different/model'}});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout.trim()).allowed,false);
  assert.deepEqual(db.pragma('foreign_key_list(ai_provider_quota)'),[]);
 } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('additive 026 twice preserves all legacy archive rows and claim timestamps',()=>{
 const db=new Database(':memory:');try {
  db.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const name of fs.readdirSync('migrations').filter(n=>n.endsWith('.sql')&&n<'026').sort())applyMigration(db,name,fs.readFileSync(path.join('migrations',name),'utf8'));
  db.prepare("INSERT INTO users(telegram_id) VALUES('quota-legacy')").run();
  db.prepare("INSERT INTO ai_weekly_summaries(user_id,period_start,period_end,timezone,period_key,locale,status,text,model,consent_version,consent_at,started_at,deadline_at,created_at) VALUES(1,'2026-10-19','2026-10-25','UTC','old','ru','ready','Старый текст','old/model','old',1,2,3,4)").run();
  const before=db.prepare('SELECT * FROM ai_weekly_summaries').all();applyMigration(db,'026_ai_provider_quota.sql',sql);db.exec(sql);assert.deepEqual(db.prepare('SELECT * FROM ai_weekly_summaries').all(),before);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
 } finally {db.close();}
});
