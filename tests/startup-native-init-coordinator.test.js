const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const guard = fs.readFileSync(path.join(__dirname, '../public/startup.js'), 'utf8');
const sdk = fs.readFileSync(path.join(__dirname, '../public/vendor/vk-bridge-3.0.2.min.js'), 'utf8');
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
function fixture({native=false, web=false, behavior='pending', slowProbe=false}={}) {
  let now=0; const timers=[], calls=[], packets=[], events={}, logs=[];
  const handlers={VKWebAppClose:{postMessage(){}}};
  const window={location:{search:web?'':'?vk_app_id=54723764',hash:''},navigator:{userAgent:''},
    addEventListener(n,f){(events[n] ||= []).push(f);}, parent:{postMessage(p){packets.push(p);}},
    fetch(u,o){logs.push(o);return Promise.resolve();}};
  if(native) window.webkit={messageHandlers:handlers};
  const ctx=vm.createContext({window,location:window.location,navigator:window.navigator,parent:window.parent,
    document:{documentElement:{},getElementById(){return null;},addEventListener(){}},
    Date:class extends Date {static now(){return now;}},console,Promise,Set,
    setTimeout(f,delay){const t={f,at:now+delay};timers.push(t);return t;},clearTimeout(t){const i=timers.indexOf(t);if(i>=0)timers.splice(i,1);}});
  vm.runInContext(guard,ctx);vm.runInContext(sdk,ctx);
  const actualSupport=window.vkBridge.supportsAsync, actualSend=window.vkBridge.send;
  const sends=[];
  window.vkBridge.send=(...args)=>{sends.push(args[0]);return actualSend(...args);};
  let probes=0, active=0, peak=0;
  window.vkBridge.supportsAsync=async (...args)=>{probes++;active++;peak=Math.max(peak,active);try{if(slowProbe)await new Promise(r=>timers.push({f:r,at:now+500}));return await actualSupport(...args);}finally{active--;}};
  function ready(replace=false) {
    const init={postMessage(p){calls.push({at:now,id:p.request_id});if(behavior==='throw')throw Error('ambiguous');
      if(behavior==='failed'||behavior==='ack')for(const f of events.VKWebAppEvent||[])f({detail:{type:behavior==='failed'?'VKWebAppInitFailed':'VKWebAppInitResult',data:{request_id:p.request_id,...(behavior==='failed'?{error_type:'client_error'}:{result:true})}}});}};
    if(!window.webkit || replace)window.webkit={messageHandlers:{VKWebAppClose:handlers.VKWebAppClose}};
    window.webkit.messageHandlers.VKWebAppInit=init;
  }
  async function advance(target) {await flush();while(true){timers.sort((a,b)=>a.at-b.at);const t=timers[0];if(!t||t.at>target)break;timers.shift();now=t.at;t.f();await flush();}now=target;await flush();}
  return {window,handlers,calls,packets,logs,timers,sends,ready,advance,pauseTo(target){now=target;},async runOverdue(){await flush();while(true){timers.sort((a,b)=>a.at-b.at);const t=timers[0];if(!t||t.at>now)break;timers.shift();t.f();await flush();}},mark(){window.KopilkaStartup.mark('bridge-loaded');},request(){return window.KopilkaStartup.initVkBridge();},stats(){return {probes,peak};}};
}
for(const behavior of ['pending','ack','failed','throw'])test(`native single-flight even with ${behavior} delivery`,async()=>{
 const f=fixture({native:true,behavior});f.ready();f.mark();const promise=f.request();for(let i=0;i<30;i++)assert.equal(f.request(),promise);await f.advance(31000);
 assert.equal(f.calls.length,1);assert.equal(f.stats().peak,1);assert.deepEqual(f.sends,['VKWebAppInit']);
});
for(const replace of [false,true])test(`partial native ${replace?'replaced':'same'} handler map`,async()=>{
 const f=fixture({native:true});f.mark();for(let i=0;i<30;i++)f.request();await f.advance(3500);assert.equal(f.calls.length,0);assert.equal(f.packets.length,0,'native supportsAsync must not send discovery');assert.equal(f.sends.length,0,'missing Init must not create an SDK pending request');
 f.ready(replace);await f.advance(31000);assert.equal(f.calls.length,1);assert.equal(f.sends.length,replace?0:1);
});
for(const arrival of [3500,9500,20000,30000])test(`cached web late native at ${arrival}ms (accelerated clock)`,async()=>{
 const f=fixture();f.mark();await f.advance(arrival-1);assert.equal(f.calls.length,0);f.ready();await f.advance(31000);for(let i=0;i<20;i++)f.request();await flush();assert.equal(f.calls.length,1);assert.equal(f.packets.filter(p=>p.handler==='VKWebAppInit').length,1);
});
test('serialized slow probes; deferred native init never creates SDK pending request',async()=>{
 const f=fixture({native:true,slowProbe:true});f.mark();for(let i=0;i<50;i++)f.request();await f.advance(2000);assert.equal(f.stats().peak,1);assert.equal(f.calls.length,0);f.ready();await f.advance(5000);assert.equal(f.calls.length,1);
});
test('never/missing callable expire after final 30s check; callers cannot revive',async()=>{
 const f=fixture({native:true});f.handlers.VKWebAppInit={postMessage:1};f.mark();await f.advance(31000);const probes=f.stats().probes;f.ready();for(let i=0;i<50;i++)f.request();await f.advance(60000);assert.equal(f.calls.length,0);assert.equal(f.stats().probes,probes);assert.equal(f.timers.length,0);
});
for (const behavior of ['pending','failed','throw']) test('cached-web fallback is reserved even with '+behavior+' delivery', async () => {
  const h = fixture({behavior}); h.request(); await h.advance(9500); h.ready(); await h.advance(10000);
  for (let i=0;i<30;i++) h.request(); await h.advance(35000);
  assert.equal(h.calls.length,1); assert.equal(h.packets.filter(x=>x.handler==='VKWebAppInit').length,1);
});
test('a slow readiness response after deadline cannot dispatch', async () => {
  const h = fixture({native:true}); let resolve; h.window.vkBridge.supportsAsync = () => new Promise(r => resolve=r);
  h.request(); await h.advance(35000); h.ready(); resolve(true); await h.advance(36000);
  assert.equal(h.calls.length,0); assert.equal(h.packets.length,0);
});
for (const native of [false,true]) test(`overdue timers cannot dispatch after deadline: ${native?'cached-native':'cached-web'}`,async()=>{
 const h=fixture({native});h.mark();await h.advance(29500);h.pauseTo(35000);h.ready();await h.runOverdue();
 assert.equal(h.calls.length,0);assert.equal(h.timers.length,0);
 for(let i=0;i<20;i++)h.request();await flush();assert.equal(h.calls.length,0);
});
test('support probe begun at inclusive deadline cannot dispatch after later resolution',async()=>{
 const h=fixture({native:true});h.mark();await h.advance(29999);const original=h.window.vkBridge.supportsAsync;let release;
 h.window.vkBridge.supportsAsync=(...args)=>new Promise(r=>{release=async()=>r(await original(...args));});h.ready();await h.advance(30000);
 assert.equal(typeof release,'function');h.pauseTo(35000);await release();await flush();await h.runOverdue();
 assert.equal(h.calls.length,0);assert.equal(h.timers.length,0);
});
test('direct fallback rechecks deadline after synchronous web transport',async()=>{
 const h=fixture();h.ready();const send=h.window.vkBridge.send;
 h.window.vkBridge.send=(...args)=>{const p=send(...args);h.pauseTo(35000);return p;};
 h.mark();await h.runOverdue();assert.equal(h.calls.length,0);assert.equal(h.timers.length,0);
});
test('website handlers never dispatch; a fresh document gets one new attempt', async () => {
 const web=fixture({web:true});web.ready();web.mark();await web.advance(31000);assert.equal(web.calls.length,0);assert.equal(web.packets.length,0);
 for(let i=0;i<2;i++){const f=fixture({native:true});f.ready();f.mark();await f.advance(1000);assert.equal(f.calls.length,1);}
});
