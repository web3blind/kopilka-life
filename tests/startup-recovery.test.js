const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness(search = '?vk_app_id=54723764&sign=secret') {
 const listeners = {}, timers = [], logs = [], native = [], requests = [];
 const elements = Object.fromEntries(['startupScreen','startupMessage','startupReload','loginScreen','appShell'].map(id => [id, { hidden: id !== 'startupScreen', textContent: '', addEventListener(){}, getAttribute(){return null;} }]));
 const window = { fetch(url,options){ requests.push({url,options}); logs.push(new Blob([options.body])); return Promise.resolve({}); }, location:{search,hash:'',reload(){}},addEventListener(n,f){(listeners[n] ||= []).push(f);},parent:{postMessage(){}} };
 const context = { window, document:{getElementById:id=>elements[id],documentElement:{},addEventListener(n,f){(listeners[n] ||= []).push(f);}}, navigator:{sendBeacon(url,body){logs.push(body);return true;}}, Blob, setTimeout(f,ms){timers.push({f,ms});return timers.length;}, clearTimeout(){}, Date, MutationObserver:class{observe(){}}, console };
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/startup.js'),'utf8'),context);
 return {window,elements,timers,logs,native,requests,fire(n,event){for(const f of listeners[n]||[])f(event);}};
}
test('startup guard retains fixed diagnostic events without leaking URL or exception', async () => {
 const h=harness();h.fire('error',{message:'Bearer SECRET',error:new Error('PRIVATE'),target:{tagName:'SCRIPT',getAttribute(){return '/app.js?SECRET';}}});
 for(const b of h.logs){const text=await b.text();assert(!/PRIVATE|SECRET|Bearer|sign=/.test(text));assert.equal(JSON.parse(text).version,'20261013-startup-diag1');}
 assert(h.logs.length>0);assert(h.logs.length<=19);
 for(const r of h.requests){assert.equal(r.options.referrerPolicy,'no-referrer');assert.equal(r.options.credentials,'omit');assert.equal(r.options.mode,'same-origin');}
});
test('native handlers before SDK load never trigger recovery',()=>{
 const h=harness();h.window.webkit={messageHandlers:{VKWebAppClose:{},VKWebAppInit:{postMessage(p){h.native.push(p);}}}};
 for(const t of h.timers.filter(t=>t.ms<=3000))t.f();assert.equal(h.native.length,0);
 h.window.vkBridge={isWebView(){return true;}};h.window.KopilkaStartup.mark('bridge-loaded');assert.equal(h.native.length,0);
});
test('late iOS handler receives bounded native init when SDK cached wrong transport',()=>{
 const h=harness();h.window.vkBridge={isWebView(){return false;},send(){return new Promise(()=>{});}};
 h.window.webkit={messageHandlers:{VKWebAppClose:{},VKWebAppInit:{postMessage(p){h.native.push(p);}}}};
 for(const t of [...h.timers].filter(t=>t.ms<=3000))t.f();
 assert.equal(h.native.length,1);assert.deepEqual(Object.keys(h.native[0]),['request_id']);
});
test('native SDK init is not duplicated by direct recovery and website does not initialize VK',()=>{
 const h=harness();h.window.vkBridge={isWebView(){return true;},send(){return Promise.resolve({result:true});}};
 h.window.webkit={messageHandlers:{VKWebAppInit:{postMessage(){h.native.push(1);}}}};
 h.window.KopilkaStartup.mark('bridge-loaded');for(const t of [...h.timers].filter(t=>t.ms<=3000))t.f();assert.equal(h.native.length,0);
});
test('fallback stays available for blocked app and disappears only after visible application UI',()=>{
 const h=harness();h.fire('DOMContentLoaded',{});for(const t of [...h.timers].filter(t=>t.ms>=8000))t.f();assert.equal(h.elements.startupScreen.hidden,false);
 h.elements.appShell.hidden=false;h.window.KopilkaStartup.mark('app-executed');assert.equal(h.elements.startupScreen.hidden,true);
});
test('website never invokes native recovery; init events expose no payload data', async()=>{
 const h=harness('');let calls=0;
 h.window.vkBridge={isWebView:()=>false};h.window.webkit={messageHandlers:{VKWebAppClose:{},VKWebAppInit:{postMessage(){calls++;}}}};
 for(const t of h.timers.filter(t=>t.ms<=2500))t.f();assert.equal(calls,0);
 h.fire('VKWebAppEvent',{detail:{type:'VKWebAppInitResult',data:{sign:'do-not-log',token:'do-not-log'}}});
 h.fire('VKWebAppEvent',{detail:{type:'VKWebAppInitFailed',data:{error_reason:'do-not-log'}}});
 const logs=await Promise.all(h.logs.map(b=>b.text()));assert.ok(logs.some(s=>s.includes('init-result')));assert.ok(logs.some(s=>s.includes('init-failed')));assert.ok(!logs.join('').includes('do-not-log'));
});
