'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/app.js', 'utf8');
function fixture() {
  let now = 100000, loads = 0;
  const replies = [], statuses = [];
  const c = {Date: {now: () => now}, Set, window: {vkBridge: {send: () => new Promise((resolve,reject) => replies.push({resolve,reject}))}}, navigator: {},
    state: {token:'fixture',user:{id:1},busy:false,refreshPending:false,artifactQueue:[],lastRefresh:0},
    document: {hidden:false,activeElement:{tagName:'BUTTON',isConnected:true},querySelector:()=>null},
    $:()=>({hidden:false}),isVkMiniApp:()=>true,L:k=>k,setStatus:k=>statuses.push(k),
    showManualShare:()=>{throw Error('unexpected fallback')},clientLog:()=>{},userSafeErrorMessage:()=>'',copyText:async()=>false,
    localDay:()=> 'new-day',withBusy:async(_,fn)=>fn(),loadData:async()=>{loads++;},};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf("let refreshedDay = ''"),source.indexOf('async function loadData()')),c);
  vm.runInContext(source.slice(source.indexOf('  function vkShareResultStatus('),source.indexOf('  const shareRefBtn')),c);
  return {c,replies,statuses,tick:n=>{now+=n;},loads:()=>loads};
}
test('lost native callback cannot suppress a stale return indefinitely',async()=>{
 const f=fixture();f.c.shareUrl('https://example.invalid');
 await f.c.refreshOnReturn();assert.equal(f.loads(),0);
 f.tick(31000);await f.c.refreshOnReturn();assert.equal(f.loads(),1);
 assert.deepEqual(f.statuses,[]);
});
test('expired older callback cannot shorten or change a newer request',async()=>{
 const f=fixture();const old=f.c.shareUrl('https://example.invalid/old');f.tick(31000);
 await f.c.refreshOnReturn();const newer=f.c.shareUrl('https://example.invalid/new');
 f.replies[0].resolve({result:true});await old;assert.deepEqual(f.statuses,[]);
 f.tick(1500);await f.c.refreshOnReturn();assert.equal(f.loads(),1);
 f.replies[1].reject({error_type:'client_error',error_data:{error_code:4}});await newer;
 assert.deepEqual(f.statuses,['shareCancelled']);
 f.tick(1100);await f.c.refreshOnReturn();assert.equal(f.loads(),2);
});
for(const outcome of ['success','cancel'])test('ordinary '+outcome+' preserves bounded return settling',async()=>{
 const f=fixture();const pending=f.c.shareUrl('https://example.invalid');await f.c.refreshOnReturn();assert.equal(f.loads(),0);
 if(outcome==='success')f.replies[0].resolve({result:true});else f.replies[0].reject({error_type:'client_error',error_data:{error_code:4}});
 await pending;await f.c.refreshOnReturn();assert.equal(f.loads(),0);
 f.tick(1100);await f.c.refreshOnReturn();assert.equal(f.loads(),1);
});
