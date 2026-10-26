'use strict';
// Deterministic client sequencing tests; not native screen-reader evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.KOPILKA_TALKBACK_CLIENT || path.join(__dirname, '../public/app.js'), 'utf8');
const part = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
const flush = async () => { for (let i=0;i<24;i++) await Promise.resolve(); };
function harness() {
  const nodes = new Map(), trace = [], post = deferred(), refresh = deferred(); let posts = 0;
  const el = id => { if (!nodes.has(id)) nodes.set(id, {id,value:'',disabled:false,dataset:{},attrs:{},isConnected:true,setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k] ?? null;},classList:{toggle(){}}}); return nodes.get(id); };
  const button = el('sleep'); button.dataset={entryType:'sleep',usedToday:'false'};
  button.closest = () => ({querySelector:()=>button});
  const state = {user:{id:1},token:'one',summary:{todayEntryTypes:[]},busy:false,historyEditingId:null};
  const document = {body:el('body'),activeElement:button,querySelectorAll:()=>[button,el('other')]};
  const ctx = vm.createContext({state,document,authEpoch:1,WeakMap,Promise,$:el,L:(k,p)=>p ? `${k}:${p.title}` : k,
    setStatus(text,type,category){trace.push({text,type,category,body:document.body.getAttribute('aria-busy')});},
    syncStatusDismiss(){},renderVkReminderOffer(){},
    api(){posts++; return post.promise;},reconcileHistoryEntry(){trace.push('reconcile');},
    renderHistory(){trace.push('history');},renderQuickActions(){button.dataset.usedToday=String(state.summary.todayEntryTypes.includes('sleep'));trace.push('quick');},renderSummary(){trace.push('summary');},
    renderAll(){trace.push('all');},refreshProduct(){return refresh.promise;},loadHistory(){return Promise.resolve();},
    showArtifactToast(a,h,announce=true){trace.push({artifacts:a,announce});}
  });
  vm.runInContext(part('const busyDisabled =','async function requestJson(')+part('async function refreshAfterCommit(','let vkReminderRequest')+part('async function createEntry(','async function createContract('),ctx);
  el('quickActions').addEventListener=(t,fn)=>{ctx.click=fn;};
  vm.runInContext(part("  $('quickActions').addEventListener('click'", "  $('daySceneShare')"),ctx);
  return {ctx,state,trace,el,button,post,refresh,posts:()=>posts,click:()=>ctx.click({target:button}),run:(type='sleep',note='')=>ctx.createEntry(type,note)};
}
const committed = artifacts => ({summary:{todayEntryTypes:['sleep'],todayLife:2},week:{},entry:{id:1},awardedArtifacts:artifacts || []});
test('commit paints and announces once before secondary reads; click is guarded, node/focus retained', async()=>{
  const h=harness(), node=h.button; const p=h.click(); assert.equal(h.posts(),1); await h.click(); assert.equal(h.posts(),1);
  assert(!h.trace.some(x=>x.category==='entry-success')); assert.equal(h.button.dataset.usedToday,'false');
  assert.equal(h.el('quickActions').getAttribute('aria-busy'),'true');
  h.post.resolve(committed()); await flush();
  assert.equal(h.button.dataset.usedToday,'true'); assert(h.trace.includes('summary')); assert(h.trace.includes('history'));
  assert.equal(h.state.busy,true); assert.equal(h.el('quickActions').getAttribute('aria-busy'),'false');
  assert.notEqual(h.el('body').getAttribute('aria-busy'),'true');
  assert.equal(h.trace.filter(x=>x.category==='entry-success').length,1);
  assert(!h.trace.includes('all')); assert.equal(h.ctx.document.activeElement,node);
  await h.click(); assert.equal(h.posts(),1); h.refresh.resolve(); await p;
  assert.equal(h.trace.filter(x=>x.category==='entry-success').length,1);
  assert.equal(h.el('quickActions').getAttribute('aria-busy'),'false'); await h.click(); assert.equal(h.posts(),1);
});
test('POST error leaves draft, no optimistic success; GET error retains commit and warns without replay',async()=>{
  const e=harness();e.el('entryNote').value='draft';const failed=e.run('sleep','draft');e.post.reject(Error('write failed'));await assert.rejects(failed,/write failed/);
  assert.equal(e.el('entryNote').value,'draft');assert(!e.trace.includes('quick'));assert.equal(e.state.busy,false);
  const h=harness(); const p=h.run();h.post.resolve(committed());await flush();h.refresh.reject(Error('GET failed'));await p;
  assert.equal(h.state.refreshFailed,true);assert.equal(h.posts(),1);assert.equal(h.trace.filter(x=>x.category==='entry-success').length,1);assert(h.trace.some(x=>x.text==='refreshPending'));
});
test('gratitude clears only matching draft; artifact success is early and dialog deferred without second announcement',async()=>{
  for(const artifacts of [[],[{id:7,title:'First'}]]){
    const h=harness(); h.el('gratitudeNote').value='thanks';const p=h.run('gratitude','thanks');h.post.resolve(committed(artifacts));await flush();
    assert.equal(h.el('gratitudeNote').value,'');assert(h.trace.some(x=>x.text===(artifacts.length?'artifactUnlockedStatus:First':'gratitudeSavedStatus')));
    assert(!h.trace.some(x=>x.artifacts));h.refresh.resolve();await p;
    if(artifacts.length)assert.equal(h.trace.find(x=>x.artifacts).announce,false);
    assert.equal(h.trace.filter(x=>x.category==='entry-success').length,1);
  }
});
test('identity changes discard stale commit; unrelated withBusy retains body default',async()=>{
  const h=harness(); const p=h.run();h.state.user={id:2};h.post.resolve(committed([{id:7}]));h.refresh.resolve();await p;
  assert(!h.trace.includes('quick'));assert(!h.trace.some(x=>x.category==='entry-success'));assert(!h.trace.some(x=>x.artifacts));assert.equal(h.state.summary.todayEntryTypes.length,0);
  const d=harness();const wait=deferred();const busy=d.ctx.withBusy('other',()=>wait.promise);
  assert.equal(d.el('body').getAttribute('aria-busy'),'true');wait.resolve();await busy;assert.equal(d.el('body').getAttribute('aria-busy'),'false');
});
test('a newer note survives commit; background-refresh click queue remains single and account-bound',async()=>{
  const h=harness();h.el('entryNote').value='old';const p=h.run('sleep','old');h.el('entryNote').value='new';h.post.resolve(committed());await flush();
  assert.equal(h.el('entryNote').value,'new');h.refresh.resolve();await p;
  const q=harness();q.state.busy=true;q.state.refreshPending=true;q.el('entryNote').value='queued';await q.click();await q.click();
  assert.equal(q.posts(),0);assert.equal(q.state.pendingQuickAfterRefresh.type,'sleep');assert.equal(q.state.pendingQuickAfterRefresh.userId,1);assert.equal(q.state.pendingQuickAfterRefresh.note,'queued');
});

test('daily pressed state has a stable name and localized description, updates in place, resets from server summary',()=>{
  const nodes=[];
  const types=[{type:'sleep',title:'Sleep',hint:'Rested',points:3},{type:'rest',title:'Rest',hint:'A break',points:1}];
  const container={dataset:{locale:'en'},children:[],innerHTML:''};
  for(const it of types){
    const icon={innerHTML:''},hint={textContent:''},points={textContent:''};
    const button={dataset:{entryType:it.type,usedToday:'false'},attrs:{},
      setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},querySelector(){return icon;}};
    nodes.push(button);
    container.children.push({dataset:{},querySelector(s){return s.startsWith('button')?button:s==='.qa-hint'?hint:points;}});
  }
  const state={summary:{todayEntryTypes:[]}};
  const note={disabled:false,attrs:{},setAttribute(k,v){this.attrs[k]=v;}};
  const ctx=vm.createContext({state,Set,locale:()=> 'en',I18N:{entryTypes:()=>types},$:id=>id==='entryNote'?note:container,
    L:(key)=>key,escapeHtml:x=>x,quickActionIcon:()=>'<svg></svg>'});
  vm.runInContext(part('function renderQuickActions()', 'function renderSummary()'),ctx);
  ctx.renderQuickActions();
  const initial=nodes.map(b=>b.attrs['aria-label']);
  assert.deepEqual(initial,['Sleep','Rest']);
  assert(nodes.every(b=>b.attrs['aria-pressed']==='false'));
  assert.equal(nodes[0].attrs['aria-description'],'Rested, addLife');
  state.summary.todayEntryTypes=['sleep'];ctx.renderQuickActions();
  assert.equal(nodes[0].attrs['aria-pressed'],'true');assert.equal(nodes[0].attrs['aria-disabled'],'true');
  assert.equal(nodes[0].attrs['aria-description'],'alreadyAddedToday');
  assert.equal(nodes[1].attrs['aria-pressed'],'false');
  assert.deepEqual(nodes.map(b=>b.attrs['aria-label']),initial);
  state.summary.todayEntryTypes=[];ctx.renderQuickActions();
  assert.equal(nodes[0].attrs['aria-pressed'],'false');assert.equal(nodes[0].attrs['aria-disabled'],undefined);
  assert.equal(nodes[0].attrs['aria-description'],'Rested, addLife');
  // Initial creation must expose the same state as the in-place path.
  container.children=[];state.summary.todayEntryTypes=['sleep'];ctx.renderQuickActions();
  assert.match(container.innerHTML,/aria-pressed="true"[^>]*aria-label="Sleep" aria-description="alreadyAddedToday"/);
  assert.match(container.innerHTML,/aria-pressed="false"[^>]*aria-label="Rest" aria-description="A break, addLife"/);
});
