'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('public/app.js','utf8');
function run(name, context) {
 const start=app.indexOf(`function ${name}(`);
 const end=app.indexOf('\nfunction ',start+1);
 vm.runInNewContext(app.slice(start,end),context);
 return context[name];
}
test('7612554 active field clears keyboard viewport even when nav stays below it',()=>{
 let moved=0;
 const control={closest:()=>true,matches:()=>true,getBoundingClientRect:()=>({top:260,bottom:310})};
 const c={document:{activeElement:control,querySelector:()=>({hidden:false,getClientRects:()=>[1],getBoundingClientRect:()=>({top:700})})},window:{innerHeight:800,visualViewport:{offsetTop:0,height:280},scrollBy:o=>moved=o.top}};
 run('keepFocusedControlVisible',c)({target:control});
 assert.equal(moved,38);
});
test('layout shrink reveals the active editable even fully below the viewport',()=>{
 let moved=0;
 const control={closest:()=>true,matches:()=>true,getBoundingClientRect:()=>({top:286,bottom:342})};
 const c={document:{activeElement:control,querySelector:()=>({hidden:false,getClientRects:()=>[1],getBoundingClientRect:()=>({top:250})})},window:{innerHeight:180,visualViewport:{height:180,offsetTop:0},scrollBy:o=>moved=o.top}};
 run('keepFocusedControlVisible',c)({target:control});assert.equal(moved,170);
});
test('crowded navigation never scrolls the active editor above the visual viewport',()=>{
 for(const offsetTop of [0,20]) {
  let moved=0,rect={top:286,bottom:342};
  const control={closest:()=>true,matches:()=>true,getBoundingClientRect:()=>rect};
  const c={document:{activeElement:control,querySelector:()=>({hidden:false,getClientRects:()=>[1],getBoundingClientRect:()=>({top:39})})},window:{innerHeight:180,visualViewport:{height:180,offsetTop},scrollBy:o=>{moved=o.top;rect={top:rect.top-o.top,bottom:rect.bottom-o.top}}}};
  const reveal=run('keepFocusedControlVisible',c);reveal({target:control});assert.equal(moved,278-offsetTop);assert.equal(rect.top,offsetTop+8);reveal({target:control});assert.equal(moved,0);
 }
});
test('offscreen links, buttons and unfocused editors do not override restored scroll',()=>{
 for(const editable of [false,true]) for(const focused of [false,true]) {
  if(editable&&focused)continue;
  let moved=0;
  const control={closest:()=>true,matches:s=>s==='button,input,textarea,select,a'||editable,getBoundingClientRect:()=>({top:286,bottom:342})};
  const c={document:{activeElement:focused?control:{},querySelector:()=>({hidden:false,getClientRects:()=>[1],getBoundingClientRect:()=>({top:160})})},window:{innerHeight:180,scrollBy:()=>moved++}};
  run('keepFocusedControlVisible',c)({target:control});assert.equal(moved,0);
 }
});
test('focus correction leaves unrelated/out-of-viewport controls alone', () => {
 let moved=0;
 const c={closest:()=>false,matches:()=>true};
 const nav={hidden:false,getClientRects:()=>[1],getBoundingClientRect:()=>({top:450})};
 run('keepFocusedControlVisible',{document:{querySelector:()=>nav},window:{innerHeight:800,scrollBy:()=>moved++}})({target:c});
 assert.equal(moved,0);
});
for (const language of ['ru','en']) test(`7611936 ${language}: saved reminder opt-in is separate from VK message permission`,()=>{
 const translations={window:{}};vm.runInNewContext(fs.readFileSync('public/i18n.js','utf8'),translations);
 const t=key=>translations.window.KopilkaI18n.t(language,key);
 for (const row of [
  {vk:true,user:{vkLinked:true,vkMessagesAllowed:true,remindersEnabled:false},key:'vkReminderStatusOff'},
  {vk:true,user:{vkLinked:true,vkMessagesAllowed:true,remindersEnabled:true},key:'vkReminderStatusOn'},
  {vk:true,user:{vkLinked:true,vkMessagesAllowed:false,remindersEnabled:true},key:'vkReminderStatusUnknown'},
  {vk:true,user:{vkLinked:true,vkMessagesAllowed:false,remindersEnabled:false},key:'vkReminderStatusUnknown'},
  {vk:false,user:{vkLinked:true,vkMessagesAllowed:true,remindersEnabled:true},key:'vkReminderStatusNeedVk'},
  {vk:true,user:{vkLinked:false,vkMessagesAllowed:true,remindersEnabled:true},key:'vkReminderStatusNeedVk'},
  {vk:true,user:null,key:'vkReminderStatusNeedVk'},
 ]) {
  const elements={vkReminderPrompt:{},vkReminderBox:{},vkReminderStatus:{setAttribute(){}}};const buttons=[{setAttribute(){}}];
  const state={user:row.user};const before=JSON.stringify(state);
  const c={state,vkReminderRequest:null,vkReminderNotice:null,vkReminderRequestCurrent:()=>false,$:id=>elements[id],L:t,isVkMiniApp:()=>row.vk,document:{querySelectorAll:()=>buttons}};
  run('renderVkReminderOffer',c)();
  assert.equal(elements.vkReminderStatus.textContent,t(row.key),JSON.stringify(row));
  assert.equal(elements.vkReminderBox.hidden,!(row.vk&&row.user?.vkLinked));
  assert.equal(JSON.stringify(state),before,'render must not change delivery or permissions');
 }
});
test('RU/EN history summaries never add a second dot after localized long date', () => {
 const context={window:{}};vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/i18n.js','utf8'),context);
 for(const locale of ['ru','en']) {
  const date=new Intl.DateTimeFormat(locale==='ru'?'ru-RU':'en-US',{dateStyle:'long',timeZone:'UTC'}).format(new Date('2026-10-05T12:00:00Z'));
  const summary=context.window.KopilkaI18n.t(locale,'historyDaySummary',{date,count:1,life:4});
  assert.ok(!summary.includes('..'),summary);
 }
});
