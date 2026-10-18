const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function harness() {
  const image = deferred(), bridge = deferred(); let click, images=0, requests=0;
  let imagePromise=image.promise, bridgePromise=bridge.promise;
  const attrs={};
  const button={id:'shareStory',dataset:{},disabled:false,addEventListener:(type,fn)=>{click=fn},setAttribute:(n,v)=>attrs[n]=v,getAttribute:n=>attrs[n]??null};
  const fallback={hidden:false};
  const scope={document:{querySelectorAll:()=>[button],body:{setAttribute:()=>{}}},state:{busy:false,profile:{vkProfileLink:'https://vk.ru/app54723764#profile=QA',vkStoryCardUrl:'https://example.invalid/qa.png'}},
    $:id=>id==='shareStory'?button:fallback,isVkMiniApp:()=>true,
    window:{vkBridge:{send:()=>{requests++;return bridgePromise}}},
    L:x=>x,setStatus:()=>{},clientLog:()=>{},showManualShare:()=>{},
    userSafeErrorMessage:e=>e.message||String(e),storyImageDataUri:()=>{images++;return imagePromise}};
  const start=source.indexOf("  const storyBtn = $('shareStory');");
  const end=source.indexOf('\n}\nasync function start()',start);
  assert.ok(start>=0&&end>start);
  const busy=source.slice(source.indexOf('const busyDisabled ='),source.indexOf('async function withBusy('));
  vm.runInNewContext(busy+'\n'+source.slice(start,end)+'\nglobalThis.qaBusy=setBusy;',scope);
  return {click:()=>click(),busy:v=>scope.qaBusy(v),button,image,bridge, images:()=>images,requests:()=>requests,
    nextCycle:()=>{imagePromise=Promise.resolve('data:image/png;base64,QA');bridgePromise=Promise.resolve({result:true})}};
}
for(const phase of ['image','native']) for(const order of ['story-first','busy-first']) for(const result of ['success','cancel','error']) test(`7613295 overlap ${phase} ${order} ${result}`,async()=>{
 const h=harness();const first=h.click();
 if(phase==='native'){h.image.resolve('data:image/png;base64,QA');await new Promise(setImmediate);}
 h.busy(true);assert.equal(h.button.disabled,true);
 const finish=async()=>{
  if(phase==='image')h.image.resolve('data:image/png;base64,QA');
  await new Promise(setImmediate);
  if(result==='success')h.bridge.resolve({result:true});else h.bridge.reject(new Error(result==='cancel'?'user denied':'failed'));
  await first;
 };
 if(order==='story-first'){await finish();assert.equal(h.button.disabled,true);await h.click();h.busy(false);}
 else {h.busy(false);assert.equal(h.button.disabled,true);await h.click();await finish();}
 assert.equal(h.requests(),1);assert.equal(h.button.disabled,false);
});

test('7613295 repeated story requests are single-flight through image and native editor opening',async()=>{
 const h=harness();const first=h.click();const second=h.click();
 assert.equal(h.images(),1);assert.equal(h.button.disabled,true);
 h.image.resolve('data:image/png;base64,QA');await new Promise(setImmediate);
 const third=h.click();assert.equal(h.requests(),1);assert.equal(h.button.disabled,true);
 h.bridge.resolve({result:true});await Promise.all([first,second,third]);assert.equal(h.button.disabled,false);
});
for(const kind of ['image failure','native cancellation','native failure']) test('7613295 story control recovers after '+kind,async()=>{
 const h=harness();const first=h.click();
 if(kind==='image failure') h.image.reject(new Error('load failed'));
 else {h.image.resolve('data:image/png;base64,QA');await new Promise(setImmediate);h.bridge.reject(new Error(kind==='native cancellation'?'user denied':'bridge failed'));}
 await first;assert.equal(h.button.disabled,false);const requestsBefore=h.requests();h.nextCycle();
 const retry=h.click();await retry;assert.equal(h.images(),2);assert.equal(h.requests(),requestsBefore+1);assert.equal(h.button.disabled,false);
});
