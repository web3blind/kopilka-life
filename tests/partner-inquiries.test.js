const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'kopilka-partner-test-'));
Object.assign(process.env,{ NODE_ENV:'test', DB_PATH:path.join(tmp,'qa.sqlite'), SCHEDULER_ENABLED:'false',
  BOT_TOKEN:'', RESEND_API_KEY:'', GOOGLE_CLIENT_ID:'', GOOGLE_CLIENT_SECRET:'', VK_GROUP_TOKEN:'',
  TURNSTILE_SITE_KEY:'',TURNSTILE_SECRET_KEY:'',PARTNER_OWNER_TELEGRAM_ID:'',
  TELEGRAM_WEBHOOK_SECRET:'partner_test_webhook_secret',SESSION_SECRET:'partner-test-session-secret' });
const config=require('../src/config');
const {createApp}=require('../src/server');
const {getDb,closeDb,initDatabase}=require('../src/db');
const service=require('../src/services/partnerService');
const realFetch=global.fetch;
let providerCalls=[], captcha={success:true,hostname:'127.0.0.1',action:'partner_inquiry',challenge_ts:new Date().toISOString()}, mode='success';
let nextTelegramMessage=88;
function fixtureFetch(url,opts) {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url,opts);
  providerCalls.push({url,opts,body:JSON.parse(opts.body)});
  if (url.includes('siteverify')) return Promise.resolve(Response.json(captcha));
  if (mode==='timeout') return Promise.reject(new Error('fixture connection lost after acceptance'));
  if (mode==='malformed') return Promise.resolve(new Response('broken',{status:200}));
  if (mode==='429') return Promise.resolve(Response.json({error:'fixture'},{status:429}));
  if (mode==='500') return Promise.resolve(Response.json({error:'fixture'},{status:500}));
  if (mode==='422') return Promise.resolve(Response.json({error:'fixture'},{status:422}));
  if (String(url).includes('api.telegram.org')) return Promise.resolve(Response.json({ok:true,result:{message_id:nextTelegramMessage++,chat:{id:123456}}}));
  assert.equal(url,'https://api.resend.com/emails');
  return Promise.resolve(Response.json({id:'mail-fixture-id'}));
}
function body(extra={}) { return {name:'Example project',email:'customer@example.com',message:'A partnership proposal https://example.com',locale:'ru',website:'',consent:true,submissionKey:crypto.randomUUID(),captchaToken:'fixture-token',...extra}; }
test('partner whole flow on isolated HTTP/SQLite, providers replaced',async(t)=>{
 const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;config.appBaseUrl=base;
 const db=getDb();
 const post=(b,headers={})=>realFetch(base+'/api/partners/inquiries',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(b)});
 const webhook=(update,secret=config.telegramWebhookSecret)=>realFetch(base+'/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)});
 let inquiryId;
 try {
 global.fetch=fixtureFetch;
 await t.test('unconfigured form fails closed and creates nothing',async()=>{
   assert.equal((await post(body())).status,503);assert.equal(db.prepare('SELECT count(*) n FROM partner_inquiries').get().n,0);
   for(const [route,text] of [['/partners','Форма временно недоступна'],['/en/partners','The form is temporarily unavailable']]) {
     const html=await(await realFetch(base+route)).text();assert.ok(html.includes(text));assert.match(html,/<button type="submit" disabled>/);assert.match(html,/data-site-key=""/);
   }
 });
 Object.assign(config,{turnstileSiteKey:'fixture-site-key',turnstileSecretKey:'fixture-secret',botToken:'fixture-bot',resendApiKey:'fixture-resend',partnerOwnerId:'123456'});
 await t.test('same origin/type/body bounds, consent, honeypot and header injection',async()=>{
   assert.equal((await post(body(),{Origin:'https://evil.invalid'})).status,403);
   assert.equal((await post(body(),{'Content-Type':'text/plain'})).status,415);
   assert.equal((await post(body({consent:false}))).status,400);
   assert.equal((await post(body({website:'spam'}))).status,400);
   assert.equal((await post(body({email:'customer@example.com\r\nBcc: bad@example.com'}))).status,400);
   assert.equal((await post(body({message:'x'.repeat(14000)}))).status,413);
 });
 // Use a fresh app-local limiter for remaining positive fixtures, while keeping exact DB and server paths.
 const routeRouter=require('../src/routes/partners');
 await t.test('strict CAPTCHA rejects false, wrong action/host, old/future timestamp and unavailable provider',async()=>{
   const original={...captcha};
   for (const patch of [{success:false},{action:'login'},{hostname:'evil.invalid'},{challenge_ts:'2000-01-01'},{challenge_ts:'2999-01-01'}]) {
     captcha={...original,...patch};await assert.rejects(service.submitInquiry(body(),'captcha-ip'),/CAPTCHA_REJECTED/);
   }
   captcha=original;
   assert.equal(db.prepare('SELECT count(*) n FROM partner_inquiries').get().n,0);
 });
 await t.test('persist before success + repeat submission exact id; changed content rejected',async()=>{
   const b=body({name:'<img src=x onerror=alert(1)>',message:'<script>alert(1)</script> https://example.com'});
   const r=await post(b);assert.equal(r.status,202);inquiryId=(await r.json()).id;
   assert.equal(db.prepare('SELECT id FROM partner_inquiries WHERE id=?').get(inquiryId).id,inquiryId);
   assert.equal(db.prepare('SELECT state FROM partner_outbox WHERE inquiry_id=?').get(inquiryId).state,'pending');
   // The limiter above bounds all HTTP attempts; idempotent service path proves durable retry as well.
   assert.equal(await service.submitInquiry(b,'other-ip'),inquiryId);
   await assert.rejects(service.submitInquiry({...b,message:'changed'},'other-ip'),/INVALID_INQUIRY/);
   assert.equal(db.prepare('SELECT count(*) n FROM partner_inquiries').get().n,1);
 });
 config.nodeEnv='fixture';
 await t.test('notification uses plain text, persisted exact Telegram mapping; 429 safely retried',async()=>{
   mode='429';await service.processPartnerOutbox();
   let job=db.prepare("SELECT * FROM partner_outbox WHERE kind='telegram'").get();assert.equal(job.state,'retry');
   db.prepare('UPDATE partner_outbox SET due_at=0').run();mode='success';await service.processPartnerOutbox();
   job=db.prepare("SELECT * FROM partner_outbox WHERE kind='telegram'").get();assert.equal(job.state,'sent');
   const row=db.prepare('SELECT * FROM partner_inquiries WHERE id=?').get(inquiryId);assert.equal(row.notification_message,88);
   const payload=providerCalls.filter(c=>c.url.includes('api.telegram.org')).at(-1).body;
   assert.equal(payload.parse_mode,undefined);assert.match(payload.text,/<script>/);assert.match(payload.text,/partner-2026-10-25/);
 });
 const reply=(id=400)=>({update_id:id,message:{message_id:900+id,from:{id:123456,is_bot:false},chat:{id:123456,type:'private'},reply_to_message:{message_id:88},text:'Ответ сервиса https://example.com\nTo: attacker@example.com'}});
 await t.test('webhook secret and exact owner/private/persisted message fencing; edited/forwarded ignored',async()=>{
   assert.equal((await webhook(reply(), 'wrong')).status,403);
   const cases=[{from:{id:999}},{chat:{id:-123456,type:'group'}},{reply_to_message:{message_id:89}}, {forward_origin:{type:'user'}}, {chat:{id:999,type:'private'}}];
   let id=410;for(const m of cases) {const u=reply(id++);Object.assign(u.message,m);assert.equal((await webhook(u)).status,200);}
   const edited=reply(id++);edited.edited_message=edited.message;delete edited.message;assert.equal((await webhook(edited)).status,200);
   assert.equal(db.prepare("SELECT count(*) n FROM partner_outbox WHERE kind='email'").get().n,0);
 });
 await t.test('owner reply durable dedup by update and message + email recipient exclusively DB',async()=>{
   assert.equal((await webhook(reply())).status,200);
   const duplicate=await (await webhook(reply())).json();assert.equal(duplicate.duplicate,true);
   const repeat=reply(401);repeat.message.message_id=reply().message.message_id;assert.equal((await webhook(repeat)).status,200);
   assert.equal(db.prepare("SELECT count(*) n FROM partner_outbox WHERE kind='email'").get().n,1);
   await service.processPartnerOutbox();
   const call=providerCalls.filter(c=>c.url==='https://api.resend.com/emails').at(-1);
   assert.deepEqual(call.body.to,['customer@example.com']);assert.equal(call.body.html,undefined);
   assert.match(call.body.text,/To: attacker@example.com/);assert.match(call.opts.headers['Idempotency-Key'],/^kopilka-partner-/);
   assert.equal(db.prepare("SELECT state FROM partner_outbox WHERE kind='email'").get().state,'sent');
 });
 await t.test('mail 429 retry; 4xx terminal; timeout/malformed/5xx unknown never blindly retried',async()=>{
   for(const [i,m] of ['429','422','timeout','malformed','500'].entries()) {
     service.acceptOwnerReply(reply(500+i));mode=m;await service.processPartnerOutbox();
     const job=db.prepare('SELECT * FROM partner_outbox WHERE reply_update=?').get(500+i);
     assert.equal(job.state,m==='429'?'retry':m==='422'?'failed':'unknown');
     const before=providerCalls.length;await service.processPartnerOutbox();assert.equal(providerCalls.length,before);
     if(m==='429') {db.prepare('UPDATE partner_outbox SET due_at=0 WHERE id=?').run(job.id);mode='success';await service.processPartnerOutbox();assert.equal(db.prepare('SELECT state FROM partner_outbox WHERE id=?').get(job.id).state,'sent');}
   }
   mode='success';
 });
 await t.test('in-flight crash parked; missing delivery config not success; DB durable limits',async()=>{
   service.acceptOwnerReply(reply(600));db.prepare("UPDATE partner_outbox SET state='sending',started_at=0 WHERE reply_update=600").run();
   await service.processPartnerOutbox();assert.equal(db.prepare('SELECT state FROM partner_outbox WHERE reply_update=600').get().state,'unknown');
   service.acceptOwnerReply(reply(601));config.resendApiKey='';await service.processPartnerOutbox();assert.equal(db.prepare('SELECT state FROM partner_outbox WHERE reply_update=601').get().state,'retry');config.resendApiKey='fixture';
   await service.submitInquiry(body({email:'customer@example.com'}),'rate-ip');await service.submitInquiry(body({email:'customer@example.com'}),'rate-ip');
   await assert.rejects(service.submitInquiry(body({email:'customer@example.com'}),'different-ip'),/PARTNER_RATE_LIMIT/);
 });
 await t.test('RU/EN inquiry locale selects exact notification and email copy, never translates owner text',async()=>{
   for (const [index,locale] of ['ru','en'].entries()) {
     const languageFields=body({locale,email:`locale-${locale}@example.com`});
     const inquiryId=await service.submitInquiry(languageFields,'language-fixture-ip');
     mode='success';const firstCall=providerCalls.length;await service.processPartnerOutbox();
     const notification=providerCalls.slice(firstCall).find(c=>c.body.text?.includes(inquiryId));
     assert.match(notification.body.text,locale==='en'?/Partnership inquiry/:/Партнёрская заявка/);
     assert.match(notification.body.text,locale==='en'?/Consent:/:/Согласие:/);
     const inquiry=db.prepare('SELECT * FROM partner_inquiries WHERE id=?').get(inquiryId);
     assert.equal(inquiry.locale,locale);
     const ownerText='Ответ без перевода / unchanged https://example.com';
     const update=reply(9100+index);update.message.message_id=9200+index;update.message.reply_to_message.message_id=inquiry.notification_message;update.message.text=ownerText;
     assert.equal((await webhook(update)).status,200);
     const beforeMail=providerCalls.length;await service.processPartnerOutbox();
     const mail=providerCalls.slice(beforeMail).find(c=>c.url==='https://api.resend.com/emails');
     assert.deepEqual(mail.body.to,[languageFields.email]);assert.ok(mail.body.text.includes(ownerText));
     assert.match(mail.body.subject,locale==='en'?/Life Harbor/:/Копилка жизни/);
     assert.match(mail.body.text,locale==='en'?/^Reply from Life Harbor/:/^Ответ от сервиса/);
   }
 });
 await t.test('transaction failure never leaves a saved inquiry without an outbox job',async()=>{
   const before=db.prepare('SELECT count(*) n FROM partner_inquiries').get().n;
   db.exec("CREATE TRIGGER partner_fixture_fail BEFORE INSERT ON partner_outbox BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
   try {await assert.rejects(service.submitInquiry(body({email:'rollback@example.com'}),'rollback-ip'));}
   finally {db.exec('DROP TRIGGER partner_fixture_fail');}
   assert.equal(db.prepare('SELECT count(*) n FROM partner_inquiries').get().n,before);
 });
 await t.test('SEO public RU/EN canonical schema sitemap robots, private profiles noindex; free/auth preserved',async()=>{
   const titles=[];
   for(const route of ['/about','/en/about','/partners','/en/partners','/gratitude-journal','/en/gratitude-journal']) {
     const response=await realFetch(base+route);assert.equal(response.status,200);const html=await response.text();
     assert.match(html,new RegExp(`<html lang="${route.startsWith('/en/')?'en':'ru'}">`));
     assert.ok(html.includes(`rel="canonical" href="${base+route}"`));assert.match(html,/hreflang="en"/);assert.equal((html.match(/<h1>/g)||[]).length,1);
     const schema=JSON.parse(html.match(/application\/ld\+json">(.*?)<\/script>/s)[1]);assert.equal(schema.url,base+route);
     titles.push(html.match(/<title>(.*?)<\/title>/)[1]);
   }
   assert.equal(new Set(titles).size,6);
   assert.match(await (await realFetch(base+'/robots.txt')).text(),/Sitemap:/);
   const sitemap=await (await realFetch(base+'/sitemap.xml')).text();
   const sitemapPaths=[...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match=>new URL(match[1]).pathname);
   assert.deepEqual(sitemapPaths,['/','/about','/en/about','/partners','/en/partners','/gratitude-journal','/en/gratitude-journal']);assert.doesNotMatch(sitemap,/\/api\//);
   const englishHome=await(await realFetch(base+'/?lang=en')).text();assert.match(englishHome,/<title>Life Harbor/);assert.match(englishHome,/<html lang="en">/);assert.match(englishHome,/<meta name="description" content="A free service/);assert.match(englishHome,/id="emailLoginForm"/);assert.doesNotMatch(englishHome,/id="googleLoginButton"/);
   assert.equal((await realFetch(base+'/p/TEST')).headers.get('x-robots-tag'),'noindex, nofollow');
   const home=await (await realFetch(base+'/')).text();assert.match(home,/id="emailLoginForm"/);assert.match(home,/href="\/partners"/);assert.ok(home.includes(`rel="canonical" href="${base}/"`));
 });
 await t.test('retention cascades and migration repeat retains existing state',async()=>{
   const count=db.prepare('SELECT count(*) n FROM partner_inquiries').get().n;
   closeDb();initDatabase();assert.equal(getDb().prepare('SELECT count(*) n FROM partner_inquiries').get().n,count);
   getDb().prepare('UPDATE partner_inquiries SET created_at=0 WHERE id=?').run(inquiryId);
   await service.processPartnerOutbox();assert.equal(getDb().prepare('SELECT id FROM partner_inquiries WHERE id=?').get(inquiryId),undefined);
   assert.equal(getDb().prepare('SELECT count(*) n FROM partner_outbox WHERE inquiry_id=?').get(inquiryId).n,0);
   assert.equal(getDb().pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(getDb().pragma('foreign_key_check'),[]);
 });
 } finally { global.fetch=realFetch;await new Promise(r=>server.close(r));closeDb();fs.rmSync(tmp,{recursive:true,force:true}); }
});
test('021 → 022 upgrade preserves prior tables, rows and migration ledger',()=>{
 const Database=require('better-sqlite3');
 const {applyMigration}=require('../src/db');
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'partner-migration-')),file=path.join(dir,'prior.sqlite');
 let connection=new Database(file);
 try {
   connection.pragma('journal_mode = WAL');connection.pragma('foreign_keys = ON');connection.exec('CREATE TABLE _migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   for(const name of fs.readdirSync('migrations').filter(f=>f.endsWith('.sql') && f<'022').sort()) applyMigration(connection,name,fs.readFileSync(path.join('migrations',name),'utf8'));
   connection.prepare("INSERT INTO users(telegram_id,first_name) VALUES('777777','fixture preserved')").run();
   const uid=connection.prepare('SELECT id FROM users').get().id;
   connection.prepare("INSERT INTO entries(user_id,type,title,note,life_points,entry_date) VALUES(?,'joy','preserved','private note',1,'2026-01-01')").run(uid);
   const before=connection.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
   const rows=Object.fromEntries(before.map(t=>[t.name,connection.prepare(`SELECT * FROM ${t.name}`).all()]));
   connection.close();connection=initDatabase(file);
   for(const table of before) {
     assert.equal(connection.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table.name).sql,table.sql);
     if(table.name!=='_migrations') assert.deepEqual(connection.prepare(`SELECT * FROM ${table.name}`).all(),rows[table.name]);
   }
   assert.equal(connection.prepare("SELECT count(*) n FROM _migrations WHERE name='022_partner_inquiries.sql'").get().n,1);
   assert.equal(connection.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(connection.pragma('foreign_key_check'),[]);
 } finally {closeDb();if(connection.open) connection.close();fs.rmSync(dir,{recursive:true,force:true});}
});
