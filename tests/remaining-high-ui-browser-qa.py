#!/usr/bin/env python3
"""Remaining high UI regressions: actual app/API/temp SQLite, explicit mocked VK.
Own port 3194 and disposable Chromium only. Never contacts a real provider.
KOPILKA_UI_QA_INTEGRATED=1 requires the parent-integrated shell (no substitution).
"""
import os, pathlib, subprocess, time, urllib.request, json, base64, hmac, hashlib, urllib.parse, sqlite3, socket, tempfile
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=pathlib.Path(os.environ.get('KOPILKA_UI_QA_OUT',(tempfile.gettempdir() + '/kopilka-qa/kopilka-critical-20261007/ui-fix')))
OUT.mkdir(parents=True,exist_ok=True)
BASE='http://127.0.0.1:3194'
DB=pathlib.Path(tempfile.mkdtemp(prefix='qa-data-',dir=OUT))/'qa.sqlite'
env={'PATH':os.environ['PATH'],'HOME':str(OUT),'TMPDIR':str(OUT),'NODE_ENV':'test','PORT':'3194','APP_BASE_URL':BASE,'WEBAPP_URL':BASE,'DB_PATH':str(DB),'SCHEDULER_ENABLED':'false','DEV_AUTH_ENABLED':'false','SESSION_SECRET':'ui-fix-qa-secret','BOT_TOKEN':'','BOT_USERNAME':'','TELEGRAM_WEBHOOK_SECRET':'ui-fix-qa-secret','VK_APP_ID':'54723764','VK_SECURE_KEY':'ui-fix-qa-key','VK_GROUP_ID':'','VK_GROUP_TOKEN':'','VK_OAUTH_CLIENT_ID':'','VK_OAUTH_CLIENT_SECRET':'','RESEND_API_KEY':'','GOOGLE_CLIENT_ID':'','GOOGLE_CLIENT_SECRET':'','VAPID_PUBLIC_KEY':'','VAPID_PRIVATE_KEY':''}
BRIDGE="""window.calls=[];window.copyMode='true';window.appMode='true';window.vkBridge={send(method,params){calls.push({method,params});if(method==='VKWebAppCopyText'){if(copyMode==='pending')return new Promise(resolve=>window.copyResolve=resolve);if(copyMode==='reject')return Promise.reject(Error('QA cancellation'));return Promise.resolve({result:copyMode==='true'});}if(method==='VKWebAppOpenApp'){if(appMode==='reject')return Promise.reject(Error('QA rejection'));return Promise.resolve({result:appMode==='true'});}return Promise.resolve({result:true});},subscribe(){},supports(){return true},supportsAsync(){return Promise.resolve(true)}};"""
SHELL='<div id="statusNotice" class="status-notice"><p id="statusRegion" role="status" aria-live="polite"></p><button id="dismissStatus" type="button" data-i18n="dismissNotification" hidden>Закрыть уведомление</button></div>'
OLD='<p id="statusRegion" class="status-region" role="status" aria-live="polite"></p>'
results=[]
def record(name,data):
 results.append({'name':name,'data':data});print(name,json.dumps(data,ensure_ascii=False),flush=True)
def sql(q,args=()):
 with sqlite3.connect(DB) as db:return db.execute(q,args).fetchall()
def launch(uid):
 values={'vk_app_id':'54723764','vk_user_id':str(uid),'vk_ts':str(int(time.time()))}
 values['sign']=base64.urlsafe_b64encode(hmac.new(env['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(values.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
 return urllib.parse.urlencode(values)
def badge(page):
 return page.evaluate("({text:document.querySelector('#supportNewCount').textContent,hidden:document.querySelector('#supportNewCount').hidden,aria:document.querySelector('#tab-button-support').getAttribute('aria-label'),summary:document.querySelector('#supportNewSummary').textContent,points:state.support.badge.points,available:state.support.actions.filter(a=>a.status==='available').length})")
proc=None;browser=None;log=open(OUT/'server.log','w');blocked=[];substitutions=[]
try:
 with socket.socket() as s:
  s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',3194))
 # Deny outgoing server HTTP(S)/fetch; no providers/scheduler enabled.
 boot="""require('dotenv').config=()=>({});global.fetch=()=>Promise.reject(Error('QA external fetch blocked'));for(const name of ['http','https']){const mod=require(name);mod.request=mod.get=()=>{throw Error('QA outgoing HTTP blocked')}}require('./src/server.js').createApp().listen(3194,'127.0.0.1')"""
 proc=subprocess.Popen(['node','-e',boot],cwd=ROOT,env=env,stdout=log,stderr=log)
 for _ in range(150):
  try:urllib.request.urlopen(BASE+'/health',timeout=.5).close();break
  except Exception:
   if proc.poll() is not None:raise RuntimeError('server stopped')
   time.sleep(.1)
 else:raise RuntimeError('health timeout')
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-background-networking'])
  for locale,uid in [('ru',8199100794),('en',8199100795)]:
   ctx=browser.new_context(viewport={'width':390,'height':800})
   try:
    def route(r):
     url=r.request.url
     if '/vendor/vk-bridge' in url:r.fulfill(status=200,body=BRIDGE,content_type='application/javascript')
     elif url.startswith(BASE):
      if r.request.is_navigation_request() and urllib.parse.urlparse(url).path=='/':
       response=r.fetch();html=response.text()
       if 'id="dismissStatus"' not in html:
        assert os.environ.get('KOPILKA_UI_QA_INTEGRATED')!='1','Parent shell not integrated'
        assert html.count(OLD)==1,'Only exact isolated HTML replacement allowed'
        html=html.replace(OLD,SHELL);substitutions.append(locale)
       r.fulfill(response=response,body=html)
      else:r.continue_()
     else:
      blocked.append(url.split('?')[0]);r.fulfill(status=200,body='<!doctype html><title>Blocked QA target</title>' if r.request.is_navigation_request() else '',content_type='text/html' if r.request.is_navigation_request() else 'application/javascript')
    ctx.route('**/*',route)
    ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(locale)+');')
    page=ctx.new_page();errors=[];posts=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:posts.append(r.url) if r.method=='POST' and '/support/actions/' in r.url else None)
    page.goto(BASE+'/?'+launch(uid));page.wait_for_function('state.user && state.support && state.profile && !state.busy && statusCategory==="ready"',timeout=30000)
    user=page.evaluate('state.user.id');assert page.evaluate('state.user.locale')==locale
    close=page.locator('#dismissStatus');region=page.locator('#statusRegion')
    assert close.is_visible() and close.is_enabled();assert close.inner_text()==('Закрыть уведомление' if locale=='ru' else 'Dismiss notification')
    page.evaluate('''()=>{const notice=document.querySelector('#statusNotice');window.noticeFont=parseFloat(getComputedStyle(notice).fontSize);notice.style.fontSize=(noticeFont*2)+'px';document.documentElement.style.fontSize='200%'}''')
    geometry=page.evaluate('''()=>{const r=document.querySelector('#statusRegion').getBoundingClientRect(),b=document.querySelector('#dismissStatus').getBoundingClientRect(),n=document.querySelector('#statusNotice');return {textRight:r.right,buttonLeft:b.left,buttonRight:b.right,scroll:n.scrollWidth,width:n.clientWidth,font:getComputedStyle(document.querySelector('#dismissStatus')).fontSize,hit:document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.id}}''')
    assert geometry['textRight']<=geometry['buttonLeft'] and geometry['buttonRight']<=390 and geometry['scroll']<=geometry['width']+1 and geometry['hit']=='dismissStatus',geometry
    close.focus();page.keyboard.press('Enter');assert region.inner_text()=='' and close.is_hidden()
    assert region.get_attribute('role')=='status' and region.get_attribute('aria-live')=='polite'
    assert page.evaluate('document.activeElement.id')=='tab-button-today'
    page.evaluate('document.documentElement.style.fontSize="";document.querySelector("#statusNotice").style.fontSize=""')
    # Simulate the advertised old-Intl path through actual renderAll (settings hidden).
    page.evaluate('''()=>{window.realDT=Intl.DateTimeFormat;window.realCatalog=Intl.supportedValuesOf;Intl.DateTimeFormat=function(lang,options={}){if(['longOffset','longGeneric'].includes(options.timeZoneName))throw new RangeError('QA old Intl');return new realDT(lang,options)};Intl.supportedValuesOf=undefined;window.savedZone=state.user.timezone;state.user.timezone='Europe/Kaliningrad';renderAll()}''')
    assert 'UTC+02:00' in page.locator('#timezone option:checked').inner_text()
    page.evaluate('''()=>{Intl.DateTimeFormat=realDT;Intl.supportedValuesOf=realCatalog;state.user.timezone=savedZone;renderAll()}''')
    # Prior visible trigger and selected-tab fallback after prior panel disappears.
    page.locator('#tab-button-support').click();page.locator('#tab-button-support').focus()
    page.evaluate("setStatus(L('ready'),'info','ready')");close.focus();page.keyboard.press('Space');assert page.evaluate('document.activeElement.id')=='tab-button-support'
    prior_button=page.locator('[data-support-open]').first;prior_button.focus()
    page.evaluate("setStatus(L('ready'),'info','ready')");page.locator('#tab-button-contract').click()
    close.focus();page.keyboard.press('Enter');assert page.evaluate('document.activeElement.id')=='tab-button-contract'
    page.locator('#tab-button-support').click()
    for flag in ['busy','refreshFailed','pendingMerge','sessionRenewalPromise','sessionRenewalBlocked']:
     page.evaluate("()=>{setStatus(L('ready'),'info','ready');window.staleClose=document.querySelector('#dismissStatus').onclick}")
     page.evaluate("flag=>{state[flag]=true;syncStatusDismiss();staleClose()}",flag)
     assert close.is_hidden() and region.inner_text()
     page.evaluate('flag=>{state[flag]=null;syncStatusDismiss()}',flag)
    page.evaluate("()=>{setStatus(L('ready'),'info','ready');window.staleClose=document.querySelector('#dismissStatus').onclick;setStatus('QA error preserved','error');staleClose()}")
    assert region.inner_text()=='QA error preserved' and close.is_hidden()
    page.locator('#tab-button-contract').click();assert region.inner_text()=='QA error preserved'
    page.locator('#tab-button-support').click()
    record(locale+'_ready_dismiss_keyboard_200pct',geometry)
    before=badge(page);assert before['text']==('Ещё 4' if locale=='ru' else '4 left'),before
    assert before['aria']==('Полезное рядом: осталось действий — 4' if locale=='ru' else 'Useful nearby: 4 actions remaining')
    for _ in range(2):
     page.locator('#tab-button-today').click();page.locator('#tab-button-support').click();assert badge(page)==before
    assert sql('SELECT COUNT(*) FROM user_support_actions WHERE user_id=?',(user,))[0][0]==0
    share_id=page.evaluate("state.support.actions.find(a=>a.slug==='share-kopilka').id")
    share=page.locator('[data-support-open="'+str(share_id)+'"]')
    page.evaluate("copyMode='pending'");share.click();page.wait_for_function('typeof copyResolve==="function"')
    assert page.evaluate('state.busy') and close.is_hidden() and not posts
    page.evaluate('copyResolve({result:false})');page.wait_for_function('!state.busy');assert badge(page)==before and close.is_hidden() and not posts
    page.evaluate("copyMode='reject'");share.click();page.wait_for_function('!state.busy');assert badge(page)==before and not posts
    page.evaluate("copyMode='true'");share.click();page.wait_for_function('!state.busy');after_copy=badge(page)
    assert after_copy['available']==3 and after_copy['points']==1 and len(posts)==1
    share.click();page.wait_for_function('!state.busy');assert badge(page)==after_copy and len(posts)==1
    page.evaluate('''()=>{window.marker={};window.markerBefore=marker;window.tokenBefore=state.token;window.parentUrl=location.href;document.querySelector('#entryNote').value='QA preserved draft';window.openTrace=[];window.realOpen=window.open;window.open=(...args)=>{openTrace.push({args,activation:navigator.userActivation.isActive});const p=realOpen(...args);window.lastPopup=p;return p}}''')
    action_id=page.evaluate("state.support.actions.find(a=>a.status==='available').id")
    url=page.evaluate('(id)=>state.support.actions.find(a=>a.id===id).url',action_id)
    button=page.locator('[data-support-open="'+str(action_id)+'"]')
    with page.expect_popup() as pi:button.click()
    popup=pi.value;popup.wait_for_url(url);popup.wait_for_load_state();page.wait_for_function('!state.busy')
    assert popup.evaluate('opener===null');popup.close()
    assert page.evaluate("marker===markerBefore && state.token===tokenBefore && location.href===parentUrl && state.activeTab==='support' && document.querySelector('#entryNote').value==='QA preserved draft'")
    assert page.evaluate('openTrace[0].args')==[url,'_blank'] and page.evaluate('openTrace[0].activation')
    after_url=badge(page);assert after_url['available']==2 and after_url['points']==2 and len(posts)==2
    with page.expect_popup() as pi:button.click()
    popup=pi.value;popup.wait_for_load_state();page.wait_for_function('!state.busy');popup.close();assert badge(page)==after_url and len(posts)==2
    page.evaluate('window.open=()=>null');next_id=page.evaluate("state.support.actions.find(a=>a.status==='available').id")
    page.locator('[data-support-open="'+str(next_id)+'"]').click();page.wait_for_function('!state.busy');assert badge(page)==after_url and len(posts)==2
    page.evaluate('window.open=window.realOpen')
    # Synthetic valid App destination on a still-available card: actual click/credit route.
    page.evaluate('(id)=>{state.support.actions.find(a=>a.id===id).url="https://vk.com/app6909581#qa"}',next_id)
    for outcome in ['false','reject']:
     page.evaluate('outcome=>window.appMode=outcome',outcome);page.locator('[data-support-open="'+str(next_id)+'"]').click();page.wait_for_function('!state.busy');assert badge(page)==after_url and len(posts)==2
    page.evaluate("appMode='true'");page.locator('[data-support-open="'+str(next_id)+'"]').click();page.wait_for_function('!state.busy');assert badge(page)['available']==1 and len(posts)==3
    assert page.evaluate("calls.filter(c=>c.method==='VKWebAppOpenApp').every(c=>c.params.app_id===6909581&&c.params.location==='qa')")
    last_id=page.evaluate("state.support.actions.find(a=>a.status==='available').id")
    with page.expect_popup() as pi:page.locator('[data-support-open="'+str(last_id)+'"]').click()
    popup=pi.value;popup.wait_for_load_state();page.wait_for_function('!state.busy');popup.close()
    final=badge(page);assert final['hidden'] and final['available']==0 and final['points']==4 and len(posts)==4
    assert final['aria']==('Полезное рядом' if locale=='ru' else 'Useful nearby')
    api_result=page.evaluate("async()=>await api('/api/support/actions?source=vk')")
    rows=sql('SELECT status,opened_at IS NOT NULL,credited_at IS NOT NULL FROM user_support_actions WHERE user_id=?',(user,))
    assert len(rows)==4 and all(row==('opened',1,1) for row in rows) and api_result['summary']['newCount']==0
    page.reload();page.wait_for_function('state.user && state.support && !state.busy');assert badge(page)['hidden'] and badge(page)['points']==4
    assert not errors,errors
    record(locale+'_remaining_credit_navigation',{'initial':before,'afterCopy':after_copy,'afterUrl':after_url,'final':final,'creditPosts':len(posts),'dbRows':rows,'apiSummary':api_result['summary'],'jsErrors':errors,'nativeVerified':False})
   finally:ctx.close()
  browser.close();browser=None
finally:
 if browser:
  try:browser.close()
  except Exception:pass # Playwright context already stopped on a failed assertion.
 if proc:
  proc.terminate()
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
 log.close()
 with socket.socket() as s:port_result=s.connect_ex(('127.0.0.1',3194))
 record('cleanup',{'serverExit':proc.returncode if proc else None,'portConnectEx':port_result,'isolatedHtmlSubstitution':substitutions,'externalRequestsPrevented':blocked,'db':str(DB)})
 (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
 assert port_result!=0,'Own server listener leaked'
print('PASS RU/EN connected actual app/API/SQLite; mocked VK; native Samsung not verified')
