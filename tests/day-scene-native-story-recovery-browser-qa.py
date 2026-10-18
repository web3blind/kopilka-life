#!/usr/bin/env python3
import os,time,base64,hashlib,hmac,urllib.parse
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
v={'vk_app_id':'54723764','vk_user_id':'81992117','vk_platform':'mobile_android','vk_ts':str(int(time.time()))}
s=urllib.parse.urlencode(sorted(v.items()))
v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),s.encode(),hashlib.sha256).digest()).decode().rstrip('=')
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for language in ['ru','en']:
   c=b.new_context(viewport={'width':393,'height':852})
   try:
    c.route('https://**/*',lambda r:r.fulfill(status=200,body=''))
    c.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
    p=c.new_page();p.goto(BASE+'/?'+urllib.parse.urlencode(v));p.wait_for_function('state.user&&!state.busy',timeout=30000)
    p.evaluate("(lang)=>{state.user.locale=lang;renderAll();window.qaCalls=0;window.vkBridge.send=(method,params)=>{if(method!=='VKWebAppShowStoryBox')return Promise.resolve({});qaCalls++;if(!params.blob.startsWith('data:image/png;base64,'))throw Error('not PNG');return new Promise((resolve,reject)=>{window.qaResolve=resolve;window.qaReject=reject})}}",language)
    button=p.locator('#daySceneShare')
    for order in ['story-first','refresh-first']:
     for result in ['cancel','false','success','error']:
      before=p.evaluate('qaCalls');button.click();p.wait_for_function('(n)=>qaCalls===n+1',arg=before)
      p.evaluate('setBusy(true)');assert button.is_disabled()
      if order=='refresh-first':p.evaluate('setBusy(false)');assert button.is_disabled()
      p.evaluate("(r)=>{if(r==='cancel')qaReject({error_data:{error_reason:'User denied'}});else if(r==='error')qaReject(new Error('native failed'));else qaResolve({result:r==='success'})}",result)
      p.wait_for_function("document.querySelector('#daySceneShare').getAttribute('aria-disabled')==='false'")
      if order=='story-first':assert button.is_disabled();p.evaluate('setBusy(false)')
      assert button.is_enabled(),(language,order,result)
    print('PASS',language,'real canvas PNG and handler: cancellation/false/error/success, both return-refresh orders, repeated opening')
   finally:c.close()
 finally:b.close()
