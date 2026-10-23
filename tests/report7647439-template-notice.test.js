'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(process.env.REPORT7647439_APP || 'public/app.js', 'utf8');
function fixture() {
  const timers=[], nodes={};
  for(const id of ['statusRegion','dismissStatus','appShell','tab','contractTitle','contractTarget','stakeAmount','stakeCurrency','rewardDescription','fundDescription']) nodes[id]={textContent:'',value:'',hidden:false,disabled:false,classList:{toggle(){}},setAttribute(k,v){this[k]=v},closest(){return null},getClientRects(){return [1]},focus(){c.document.activeElement=this}};
  nodes.stakeCurrency.value='RUB'; nodes.tab.dataset={templateId:'dream'};
  const template={id:'dream',title:'Dream',targetValue:'3 of 7'};
  const c={state:{user:{id:1},activeTab:'contract',product:{contractTemplates:[template]}},authEpoch:0,templateReplaceDecision:null,$:id=>nodes[id],L:k=>k,setTimeout:(fn,ms)=>timers.push({fn,ms}),updateContractCounters(){c.counts++},counts:0,confirmTemplateReplacement:async()=>true,document:{activeElement:nodes.tab,contains:el=>Object.values(nodes).includes(el),querySelector:()=>nodes.tab,querySelectorAll:()=>[nodes.tab]}};
  vm.createContext(c); vm.runInContext(app.slice(app.indexOf('let statusRevision ='),app.indexOf('function setLoginStatus(')),c);
  const start=app.indexOf('async function applyTemplate(');vm.runInContext(app.slice(start,app.indexOf('function renderMergePrompt()',start)),c);
  return {c,nodes,timers,run:s=>vm.runInContext(s,c)};
}
test('actual applyTemplate publishes localized explicit 5-second notification; close preserves values and Ready',async()=>{
  const f=fixture();await f.c.applyTemplate('dream');assert.equal(f.nodes.contractTitle.value,'Dream');assert.equal(f.c.counts,1);
  assert.equal(f.run('statusCategory'),'template-applied');assert.equal(f.nodes.dismissStatus.hidden,false);assert.equal(f.nodes.dismissStatus['aria-label'],'dismissNotification');assert.equal(f.timers[0].ms,5000);
  f.nodes.dismissStatus.focus();f.nodes.dismissStatus.onclick();assert.equal(f.nodes.statusRegion.textContent,'');assert.equal(f.c.document.activeElement,f.nodes.tab);assert.equal(f.nodes.contractTarget.value,'3 of 7');assert.equal(f.run('readyNoticeDismissed'),false);
  f.c.setStatus('Ready','info','ready');assert.equal(f.nodes.statusRegion.textContent,'Ready');
});
test('automatic expiry returns focused close to template without suppressing Ready',async()=>{const f=fixture();await f.c.applyTemplate('dream');assert.equal(f.timers.length,1);f.nodes.dismissStatus.focus();f.timers[0].fn();assert.equal(f.nodes.statusRegion.textContent,'');assert.equal(f.c.document.activeElement,f.nodes.tab);assert.equal(f.run('readyNoticeDismissed'),false)});
test('stale timer and close never clear newer error or share',async()=>{const f=fixture();await f.c.applyTemplate('dream');assert.equal(f.timers.length,1);const timer=f.timers[0],close=f.nodes.dismissStatus.onclick;for(const args of [['warning','error'],['long share','info','share-unconfirmed']]){f.c.setStatus(...args);timer.fn();close();assert.equal(f.nodes.statusRegion.textContent,args[0])}});
for(const guard of ['busy','refreshFailed','pendingMerge','sessionRenewalPromise','sessionRenewalBlocked'])test('expiry/close respect '+guard,async()=>{const f=fixture();await f.c.applyTemplate('dream');assert.equal(f.timers.length,1);const close=f.nodes.dismissStatus.onclick;f.c.state[guard]=true;f.c.syncStatusDismiss();close();f.timers[0].fn();assert.equal(f.nodes.dismissStatus.hidden,true);assert.equal(f.nodes.statusRegion.textContent,'templateApplied')});
test('ordinary info/error and long share never gain timers',()=>{const f=fixture();for(const args of [['info'],['error','error'],['share','info','share-unconfirmed']]){f.c.setStatus(...args);assert.equal(f.timers.length,0);assert.equal(f.nodes.dismissStatus.hidden,args[2]!=='share-unconfirmed')}});
