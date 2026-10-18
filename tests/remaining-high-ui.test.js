const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');
function part(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function statusHarness() {
  const region = { textContent: '', classList: { toggle() {} } };
  const tab = { focus() { document.activeElement = this; } };
  const button = { hidden: true, disabled: false, textContent: '', attributes: {}, setAttribute(k,v) { this.attributes[k]=v; }, focus() { document.activeElement = this; } };
  const document = { activeElement: tab, contains: () => true, querySelector: () => tab, body: {} };
  const state = { busy: false, refreshFailed: false, activeTab: 'today', user: {}, sessionRenewalBlocked: false };
  const timers = [];
  const scope = { state, document, setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; }, $: id => ({ statusRegion: region, dismissStatus: button, statusNotice: { dataset: {} }, appShell: { hidden: false } })[id], L: x => x };
  vm.runInNewContext(part(source.includes('let statusRevision') ? 'let statusRevision' : 'function setStatus(', 'function setLoginStatus(') + '\nglobalThis.qa={setStatus};', scope);
  return { ...scope.qa, state, region, button, document, tab, timers, runTimers() { timers.splice(0).forEach(timer => timer.callback()); } };
}
for (const lang of ['ru', 'en']) test(`7614328 ${lang} remaining wording`, () => {
  const scope = { window: {}, Intl }; vm.runInNewContext(fs.readFileSync('public/i18n.js','utf8'), scope);
  const t = (key,params) => scope.window.KopilkaI18n.t(lang,key,params);
  assert.equal(t('supportTabNewShort',{count:3}),lang==='ru'?'Ещё 3':'3 left');
  assert.equal(t('supportTabNew',{count:3}),lang==='ru'?'Полезное рядом: осталось действий — 3':'Useful nearby: 3 actions remaining');
  assert.ok(!/(?:^|\s)(?:нов|new)/i.test(t('supportNoNew')));
});
test('7614161 ready-only sibling dismissal preserves live text node and returns focus', () => {
  const h=statusHarness(); h.setStatus('ready','info','ready'); assert.equal(h.button.hidden,false);
  h.button.focus(); h.button.onclick(); assert.equal(h.region.textContent,''); assert.equal(h.document.activeElement,h.tab);
});
for (const flag of ['busy','refreshFailed','pendingMerge','sessionRenewalPromise','sessionRenewalBlocked']) test('7614161 guard '+flag,()=>{
  const h=statusHarness();h.setStatus('ready','info','ready');const stale=h.button.onclick;
  h.state[flag]=true;stale();assert.equal(h.region.textContent,'ready');
  h.setStatus('ready','info','ready');assert.equal(h.button.hidden,true);
});
test('7614161 error/progress/recovery messages and stale callbacks cannot be dismissed',()=>{
  const h=statusHarness();h.setStatus('ready','info','ready');const stale=h.button.onclick;
  for(const [text,type] of [['failure','error'],['saving','info'],['session recovery','info']]) {h.setStatus(text,type);assert.equal(h.button.hidden,true);stale();assert.equal(h.region.textContent,text);}
});
test('7614161 an older ready revision cannot clear a newer ready message',()=>{
  const h=statusHarness();h.setStatus('first','info','ready');const stale=h.button.onclick;
  h.setStatus('second','info','ready');stale();assert.equal(h.region.textContent,'second');
});
test('7614161 visible prior trigger restores focus; hidden prior falls back to selected tab',()=>{
  let h=statusHarness();const prior={hidden:false,disabled:false,closest(){return this.hidden?{}:null;},getClientRects(){return [{}];},focus(){h.document.activeElement=this;}};
  h.document.activeElement=prior;h.setStatus('ready','info','ready');h.button.focus();h.button.onclick();assert.equal(h.document.activeElement,prior);
  // A fresh lifecycle: a dismissed Ready is now intentionally idempotent.
  h=statusHarness();h.document.activeElement=prior;
  h.setStatus('ready','info','ready');prior.hidden=true;h.button.focus();h.button.onclick();assert.equal(h.document.activeElement,h.tab);
});
test('7624318 artifact unlock uses the guarded entry-success timer without auto-closing its dialog', () => {
  const h = statusHarness();
  const elements = Object.fromEntries(['artifactToast', 'artifactToastImage', 'artifactToastTitle', 'artifactToastText', 'artifactToastClose'].map(id => [id, { hidden: true, focus() {}, loading: '' }]));
  const scope = { state: { artifactQueue: [{ title: 'Cat', unlockedText: 'Unlocked', alt: 'Cat', image: '/cat.webp' }] }, $: id => elements[id], L: () => 'Artifact unlocked', setArtifactBackgroundInert() {}, setStatus: h.setStatus };
  vm.runInNewContext(part('function renderArtifactToast(', 'function hideArtifactToast(') + '\nrenderArtifactToast();', scope);
  assert.equal(elements.artifactToast.hidden, false);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].milliseconds, 5000);
  h.runTimers();
  assert.equal(h.region.textContent, '');
  assert.equal(elements.artifactToast.hidden, false);
  assert.equal(scope.state.artifactQueue.length, 1);
});
for (const category of ['ready', 'entry-success']) {
  test(`transient ${category} auto-dismisses after its bounded timer`, () => {
    const h = statusHarness(); h.setStatus('done', 'info', category);
    assert.equal(h.timers.length, 1); assert.equal(h.timers[0].milliseconds, 5000);
    h.runTimers(); assert.equal(h.region.textContent, '');
  });
  test(`transient ${category} timer does not clear a newer error or draft warning`, () => {
    for (const [text, type, nextCategory] of [['failed', 'error', 'error'], ['unsaved', 'info', 'settings-unsaved']]) {
      const h = statusHarness(); h.setStatus('done', 'info', category);
      h.setStatus(text, type, nextCategory); h.runTimers(); assert.equal(h.region.textContent, text);
    }
  });
  for (const flag of ['busy', 'refreshFailed', 'pendingMerge', 'sessionRenewalPromise', 'sessionRenewalBlocked']) {
    test(`transient ${category} timer respects ${flag}`, () => {
      const h = statusHarness(); h.setStatus('done', 'info', category);
      h.state[flag] = true; h.runTimers(); assert.equal(h.region.textContent, 'done');
    });
  }
}
function openHarness(vk=true) {
  const calls=[],popup={opener:{},close(){this.closed=true;},location:{replace(){throw Error('two step');}}};
  const scope={URL,isVkMiniApp:()=>vk,vkInternalUrl:()=>true,L:x=>x,withTimeout:p=>p,window:{open:(...args)=>{calls.push(args);return popup;},vkBridge:{send:(m,p)=>{calls.push([m,p]);return Promise.resolve({result:true});}}}};
  vm.runInNewContext(part('function openPlatformUrl(', 'async function openSupportAction(')+'\nglobalThis.openUrl=openPlatformUrl;',scope);
  return {scope,calls,popup};
}
test('7613897 direct valid destination, two arguments, cleared opener, blocked rejection',async()=>{
  const h=openHarness();await h.scope.openUrl('https://vk.com/blind_dev');assert.deepEqual(h.calls,[['https://vk.com/blind_dev','_blank']]);assert.equal(h.popup.opener,null);
  h.scope.window.open=()=>null;assert.throws(()=>h.scope.openUrl('https://vk.com/blind_dev'));
  assert.throws(()=>h.scope.openUrl('http://vk.com/blind_dev'));assert.throws(()=>h.scope.openUrl('https://u:p@vk.com/blind_dev'));
});
test('7613897 OpenApp numeric method success, false and rejection',async()=>{
  const h=openHarness();await h.scope.openUrl('https://vk.com/app6909581#test');assert.equal(h.calls[0][0],'VKWebAppOpenApp');assert.equal(h.calls[0][1].app_id,6909581);assert.equal(h.calls[0][1].location,'test');
  h.scope.window.vkBridge.send=()=>Promise.resolve({result:false});await assert.rejects(h.scope.openUrl('https://vk.com/app6909581'));
  h.scope.window.vkBridge.send=()=>Promise.reject(Error('QA'));await assert.rejects(h.scope.openUrl('https://vk.com/app6909581'));
});
