'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function harness() {
  const elements=new Map(), calls=[], opens=[], navigations=[];
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,classList:{add(){},remove(){},toggle(){}},appendChild(n){this.link=n;}});return elements.get(id);};
  const popup={closed:false,location:{replace:url=>navigations.push(url)},close(){this.closed=true;}};
  const window={location:{origin:'https://life.example',search:'',hash:''},localStorage:{getItem(){},setItem(){}},addEventListener(){},setInterval(){return 1;},clearInterval(){},open:(...args)=>{opens.push(args);return popup;}};
  const c=vm.createContext({window,document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>null,createElement:()=>({}),body:{}},navigator:{},URL,URLSearchParams,Intl,Date,setTimeout,clearTimeout,console,crypto:require('crypto').webcrypto});
  const run=s=>vm.runInContext(s,c);
  run(fs.readFileSync(require.resolve('../public/i18n.js'),'utf8'));
  const src=fs.readFileSync(process.env.KOPILKA_CLIENT_PREIMAGE || require.resolve('../public/app.js'),'utf8');run(src.slice(0,src.indexOf('(async () => {\n  fireVkBridgeInit();')));
  Object.assign(c,{calls,popup});
  run(`state.token='cached-A'; clientLog=()=>{};setStatus=()=>{};initVkBridge=async()=>{};vkLaunchParams=()=> 'stale';freshVkBridgeLaunchParams=async()=>'';
    captureRefCode=()=>'';detectTimezone=()=> 'UTC'; rememberRecoveryNotice=()=>{};setVerifiedUser=u=>state.user=u;
    loadData=async()=>calls.push('private:'+state.user.id); showSessionRecovery=async()=>calls.push('recovery'); renderAll=()=>{};
    getPublicConfig=async()=>({vkOAuthEnabled:true});`);
  return {run,c,el,calls,opens,navigations,popup};
}
test('failed bridge refresh continues only through server checked resume; cached bearer is never blindly loaded',async()=>{
  const h=harness();h.run(`api=async(path,opts)=>{calls.push(path);if(path==='/api/auth/vk/resume'){if(opts.authToken!=='cached-A')throw Error('missing bearer');return {token:'cached-A',user:{id:1}}}throw Object.assign(Error('stale'),{status:401})};`);
  await h.run('handleVkAuth()');assert.deepEqual(h.calls,['/api/auth/vk','/api/auth/vk/resume','private:1']);assert.equal(h.run('state.token'),'cached-A');
});
test('fresh bridge B wins over cached A; failed recovery and link-only never load cached private data',async()=>{
  const h=harness();h.run(`freshVkBridgeLaunchParams=async()=> 'fresh-B';api=async(path,opts)=>{calls.push(path);if(JSON.parse(opts.body).launchParams==='fresh-B')return {token:'new-B',user:{id:2}};throw Object.assign(Error('stale'),{status:401})};`);
  await h.run('handleVkAuth()');assert.deepEqual(h.calls,['/api/auth/vk','/api/auth/vk','private:2']);
  for(const link of [false,true]){const x=harness();x.run(`api=async(path)=>{calls.push(path);throw Object.assign(Error('reject'),{status:401})}`);await x.run(`handleVkAuth({linkOnly:${link}})`);assert(!x.calls.some(c=>c.startsWith('private:')));assert.equal(x.calls.includes('/api/auth/vk/resume'),!link);}
});
test('explicit OAuth creates intent in opener, transports no secret in window.name, always exposes external-browser link',async()=>{
  const h=harness();h.run(`api=async(path,opts)=>{calls.push({path,opts});return {channel:JSON.parse(opts.body).channel,launchUrl:'https://life.example/api/auth/vk-oauth/start?intent='+ 'i'.repeat(32)}};`);
  const pending=h.run("startVkOAuth('link', $('vkLinkStatus'))");assert.equal(h.opens.length,1,'popup reserved during click');
  assert.equal(h.opens[0][1],'_blank','no JSON/bearer in native window name');await pending;
  assert.equal(h.calls[0].path,'/api/auth/vk-oauth/intent');assert.equal(h.calls[0].opts.authToken,'cached-A');
  const url='https://life.example/api/auth/vk-oauth/start?intent='+ 'i'.repeat(32);
  assert.deepEqual(h.navigations,[url]);assert.equal(h.el('vkLinkStatus').link.href,url,'real link remains even with reparented live WindowProxy');
  assert.equal(h.el('vkLinkStatus').link.rel,'noopener');assert.equal(h.run('state.token'),'cached-A');
});

test('correlated explicit OAuth handoff verifies the returned bearer instead of repeating the failed saved launch',async()=>{
  const h=harness();h.run(`state.vkOAuthWindow=popup;state.vkOAuthAction='auth';state.vkOAuthChannel='c'.repeat(32);
    popup.postMessage=()=>{};setVkAttributionVisibility=()=>{};applyStaticI18n=()=>{};isVkMiniApp=()=>true;
    loadPendingMerge=async()=>{};authenticate=async()=>{calls.push('launch-again');throw Error('stale')};
    loadData=async()=>{calls.push('verified-private');state.user={id:3}};showLoginScreen=async()=>{};`);
  await h.run(`receiveVkOAuthHandoff({origin:window.location.origin,source:popup,data:{type:'kopilka:vk-oauth',action:'auth',channel:state.vkOAuthChannel,token:'oauth-verified'}})`);
  assert.deepEqual(h.calls,['verified-private']);assert.equal(h.run('state.token'),'oauth-verified');
});
