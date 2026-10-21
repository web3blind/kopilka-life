'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(process.env.REPORT7644834_APP || 'public/app.js', 'utf8');
function fixture() {
  const timers = [], nodes = {};
  for (const id of ['statusRegion', 'dismissStatus', 'appShell', 'shareFallback', 'shareFallbackLink', 'tab']) nodes[id] = {
    textContent: '', hidden: false, disabled: false, value: '', classList: { toggle() {} },
    setAttribute(k,v) { this[k]=v; }, removeAttribute(k) { delete this[k]; }, closest() { return null; },
    getClientRects() { return [1]; }, focus() { c.document.activeElement=this; }, select() {},
  };
  const c = { state: { user: {} }, $: id => nodes[id], L: k => k, setTimeout: (fn, ms) => timers.push({fn,ms}),
    document: { activeElement: nodes.tab, contains: el => Object.values(nodes).includes(el), querySelector: () => nodes.tab } };
  vm.createContext(c);
  vm.runInContext(app.slice(app.indexOf('let statusRevision ='), app.indexOf('function setLoginStatus(')), c);
  const start=app.indexOf('  function showManualShare(');
  vm.runInContext(app.slice(start, app.indexOf('  function vkShareResultStatus(', start)), c);
  return { c, nodes, timers, run: s => vm.runInContext(s,c) };
}
test('nonfatal manual fallback is dismissible, persistent, preserves field and future Ready', () => {
  const f=fixture(); f.c.showManualShare('https://example.invalid/ref', 'shareUnconfirmed','info',true);
  assert.equal(f.nodes.dismissStatus.hidden,false);
  assert.equal(f.nodes.dismissStatus['aria-label'],'dismissNotification');
  assert.equal(f.timers.length,0, 'long notice has no automatic timer');
  f.nodes.dismissStatus.focus(); f.nodes.dismissStatus.onclick();
  assert.equal(f.nodes.statusRegion.textContent,'');
  assert.equal(f.nodes.shareFallback.hidden,false);
  assert.equal(f.nodes.shareFallbackLink.value,'https://example.invalid/ref');
  assert.equal(f.c.document.activeElement,f.nodes.shareFallbackLink);
  assert.equal(f.run('readyNoticeDismissed'),false);
  f.c.setStatus('ready','info','ready'); assert.equal(f.nodes.statusRegion.textContent,'ready');
  f.nodes.dismissStatus.onclick(); f.c.setStatus('late','info','ready');
  assert.equal(f.nodes.statusRegion.textContent,'');
});
test('stale share close cannot erase a newer status; Ready timer cannot erase share', () => {
  const f=fixture(); f.c.setStatus('ready','info','ready');
  const timer=f.timers[0];
  f.c.showManualShare('u','shareUnconfirmed','info'); timer.fn();
  assert.equal(f.nodes.statusRegion.textContent,'shareUnconfirmed');
  const stale=f.nodes.dismissStatus.onclick;
  f.c.setStatus('new warning','error');stale();
  assert.equal(f.nodes.statusRegion.textContent,'new warning');assert.equal(f.nodes.dismissStatus.hidden,true);
});
for (const flag of ['busy','refreshFailed','pendingMerge','sessionRenewalPromise','sessionRenewalBlocked']) test('durable guard '+flag, () => {
  const f=fixture();f.c.state[flag]=true;f.c.showManualShare('u','shareUnconfirmed','info',true);
  assert.equal(f.nodes.dismissStatus.hidden,true);const text=f.nodes.statusRegion.textContent;
  f.nodes.dismissStatus.onclick();assert.equal(f.nodes.statusRegion.textContent,text);
});
test('failed copy, generic info and unconfirmed error remain durable; copy restores error', () => {
  const f=fixture();
  for (const args of [['copyFailed','error'],['shareUnconfirmed','error'],['copyFailed','info']]) {
    f.c.showManualShare('u',...args);assert.equal(f.nodes.dismissStatus.hidden,true);
  }
  f.c.setStatus('error','error');f.c.setStatus('copied','info','copy');
  f.timers.at(-1).fn();assert.equal(f.nodes.statusRegion.textContent,'error');
  assert.equal(f.nodes.dismissStatus.hidden,true);
});
test('focus fallback if manual input detached; old shell without button stays safe', () => {
  const f=fixture();f.c.showManualShare('u','shareUnconfirmed','info');
  const input=f.nodes.shareFallbackLink;delete f.nodes.shareFallbackLink;
  f.nodes.dismissStatus.focus();f.nodes.dismissStatus.onclick();
  assert.equal(f.c.document.activeElement,f.nodes.tab);
  f.nodes.shareFallbackLink=input;delete f.nodes.dismissStatus;
  assert.doesNotThrow(()=>f.c.showManualShare('u','shareUnconfirmed','info'));
});
