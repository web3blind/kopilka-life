'use strict';
// Report 7643046: frontend-only privacy disclosure, no referral identity changes.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(process.env.KOPILKA_REFERRAL_CLIENT || path.join(root,'public/app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
function harness(mode='web',clipboard='ok') {
  const nodes=new Map(),statuses=[],calls=[];
  const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:true,attrs:{},addEventListener(t,f){this.click=f},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},focus(){calls.push('focus')},select(){calls.push('select')}});return nodes.get(id)};
  const profile={refLink:'https://example.invalid/?ref=ABC234',profileLink:'https://example.invalid/p/ABC234',botLink:'https://t.me/fixture?start=ABC234',vkRefLink:'https://vk.com/app54723764#ref=ABC234',vkProfileLink:'https://vk.com/app54723764#profile=ABC234'};
  el('refLink').value=profile.profileLink;
  const navigator={};if(clipboard!=='none')navigator.clipboard={async writeText(v){calls.push(['copy',v]);if(clipboard==='fail')throw Error('fixture denied')}};
  const window={};if(mode==='tg')window.Telegram={WebApp:{initData:'fixture',switchInlineQuery(...args){calls.push(['tg',...args])}}};
  if(mode==='vk')window.vkBridge={async send(method,args){calls.push([method,args]);return {result:true}}};
  if(mode==='native')navigator.share=async args=>{calls.push(['native',args])};
  const c=vm.createContext({window,navigator,Date,URL,console,$:el,state:{profile},isVkMiniApp:()=>mode==='vk',withTimeout:p=>p,clientLog(){},userSafeErrorMessage:e=>e.message,setStatus:(text,type,category)=>statuses.push({text,type,category}),vkShareRequestId:0,vkSharePending:new Set(),vkShareReturnUntil:0});
  vm.runInContext(fs.readFileSync(path.join(root,'public/i18n.js'),'utf8')+'\nthis.I18N=window.KopilkaI18n;this.L=(key)=>I18N.t("ru",key);',c);
  vm.runInContext(source.slice(source.indexOf("  const copyBtn = $('copyRefLink');"),source.indexOf('  async function storyImageDataUri(')),c);
  return {c,el,statuses,calls,profile};
}
test('persistent translated notice describes both referral buttons (not profile/story)',()=>{
  assert.match(html, /id="referralPrivacyNotice"[^>]*data-own-profile[^>]*data-i18n="referralPrivacyNotice"/);
  for(const id of ['copyRefLink','shareRefLink'])assert.match(html,new RegExp('id="'+id+'"[^>]*aria-describedby="referralPrivacyNotice"'));
  for(const lang of ['ru','en']){
    const h=harness();const text=vm.runInContext(`I18N.t('${lang}','referralPrivacyNotice')`,h.c);
    assert.notEqual(text,'referralPrivacyNotice');assert.match(text,lang==='ru'?/Личные заметки не показываются/:/Private notes are not shown/);
    assert.match(text,lang==='ru'?/приглаш/:/invit/);
  }
});
test('actual copy click preserves link and includes privacy in clipboard success feedback',async()=>{
  const h=harness();await h.el('copyRefLink').click();assert.deepEqual(h.calls,[['copy',h.profile.profileLink]]);
  assert.equal(h.statuses.at(-1).text, h.c.L('copied')+' '+h.c.L('referralPrivacyNotice'));
  assert.equal(h.statuses.at(-1).category,'copy');
});
for(const clipboard of ['fail','none'])test('referral manual copy '+clipboard+' is truthful and described; unrelated fallback clears referral context',async()=>{
  const h=harness('web',clipboard);await h.el('copyRefLink').click();
  assert.equal(h.el('shareFallback').hidden,false);assert.equal(h.el('shareFallbackLink').value,h.profile.profileLink);
  assert.match(h.el('shareFallbackLink').attrs['aria-describedby'],/referralPrivacyNotice/);
  assert.equal(h.statuses.at(-1).text,h.c.L('copyFailed')+' '+h.c.L('referralPrivacyNotice'));
  h.c.showManualShare('https://example.invalid/unrelated');
  assert.equal(h.el('shareFallbackLink').attrs['aria-describedby'],undefined);
  assert.equal(h.statuses.at(-1).text,h.c.L('copyFailed'));
});
for(const mode of ['web','tg','vk','native'])test('referral share route '+mode+' preserves destination and promotional text',async()=>{
  const h=harness(mode);h.el('shareRefLink').click();await new Promise(r=>setImmediate(r));
  const expected=mode==='tg'?h.profile.botLink:mode==='vk'?h.profile.vkRefLink:h.profile.refLink;
  const call=h.calls.find(c=>Array.isArray(c));assert(call);
  if(mode==='web'){assert.equal(call[1],expected);assert.equal(h.statuses.at(-1).text,h.c.L('copied')+' '+h.c.L('referralPrivacyNotice'))}
  if(mode==='tg')assert.equal(call[1],h.c.L('shareRefText')+' '+expected);
  if(mode==='native'||mode==='vk'){const payload=call[1];assert.equal(payload.url||payload.link,expected);assert.equal(payload.text,h.c.L('shareRefText'))}
});
test('profile copy and generic sharing keep bare copied feedback',async()=>{
  const h=harness();h.el('shareProfile').click();await new Promise(r=>setImmediate(r));
  assert.equal(h.calls[0][1],h.profile.profileLink);assert.equal(h.statuses.at(-1).text,h.c.L('copied'));
  await h.c.shareUrl('https://example.invalid/other','other');assert.equal(h.statuses.at(-1).text,h.c.L('copied'));
});
test('referral native failure and VK unconfirmed retain disclosure in manual fallback',async()=>{
  for(const mode of ['native','vk']){
    const h=harness(mode);if(mode==='native')h.c.navigator.share=async()=>{throw Error('fixture failed')};else h.c.window.vkBridge.send=async()=>({});
    h.el('shareRefLink').click();await new Promise(r=>setImmediate(r));
    assert.equal(h.el('shareFallback').hidden,false);assert.match(h.el('shareFallbackLink').attrs['aria-describedby'],/referralPrivacyNotice/);
    assert(h.statuses.at(-1).text.includes(h.c.L('referralPrivacyNotice')));
  }
});
