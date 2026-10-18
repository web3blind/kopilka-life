#!/usr/bin/env python3
"""7613295: real app/API/image conversion, mocked native editor, isolated QA only."""
import os, time, base64, hashlib, hmac, urllib.parse
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
assert os.environ['VK_SECURE_KEY']=='browser-qa-vk-secure-key'
def launch():
 values={'vk_app_id':'54723764','vk_user_id':'81992007','vk_ts':str(int(time.time()))}
 check=urllib.parse.urlencode(sorted(values.items()))
 values['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),check.encode(),hashlib.sha256).digest()).decode().rstrip('=')
 return urllib.parse.urlencode(values)
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for locale in ['ru','en']:
   context=browser.new_context(viewport={'width':393,'height':852})
   try:
    context.route('https://**/*',lambda r:r.fulfill(status=200,body=''))
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    context.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
    page.goto(BASE+'/?'+launch())
    page.wait_for_function('state.user&&state.profile&&!state.busy',timeout=30000)
    page.evaluate('''(locale)=>{
      state.user.locale=locale;isVkMiniApp=()=>true;renderAll();
      window.qaFetch=fetch;window.qaImages=0;window.qaCalls=[];
      window.fetch=(...args)=>String(args[0]).includes('/api/story-card/')?
        (qaImages++,new Promise(resolve=>window.qaImageRelease=()=>resolve(qaFetch(...args).then(r=>{window.qaImageStatus=r.status;window.qaImageType=r.headers.get('content-type');return r})))):qaFetch(...args);
      window.vkBridge={send:(method,params)=>{
        qaCalls.push({method,png:params.blob.startsWith('data:image/png;base64,'),attachment:params.attachment});
        return new Promise((resolve,reject)=>{window.qaResolve=resolve;window.qaReject=reject});
      }};
    }''',locale)
    page.locator('#tab-button-profile').click()
    button=page.locator('#shareStory');button.click()
    page.wait_for_function('qaImages===1')
    assert button.is_disabled()
    button.dispatch_event('click');button.dispatch_event('click')
    assert page.evaluate('qaImages')==1
    page.evaluate('qaImageRelease()');page.wait_for_function("qaCalls.length===1||!document.querySelector('#shareStory').disabled")
    assert page.evaluate('qaCalls.length')==1,page.evaluate("({imageUrl:state.profile.vkStoryCardUrl,status:document.querySelector('#statusRegion').innerText,errors:qaCalls.length,http:window.qaImageStatus,type:window.qaImageType})")
    assert button.is_disabled()
    button.dispatch_event('click');assert page.evaluate('qaCalls.length')==1
    assert page.evaluate("qaCalls[0].method==='VKWebAppShowStoryBox'&&qaCalls[0].png&&qaCalls[0].attachment.type==='url'")
    page.evaluate('qaResolve({result:true})');page.wait_for_function("!document.querySelector('#shareStory').disabled")
    for result in ['cancel','error','success']:
      button.click();page.wait_for_function('qaImages>qaCalls.length')
      page.evaluate('qaImageRelease()')
      try:page.wait_for_function('qaCalls.length===qaImages',timeout=5000)
      except Exception:
       print('DIAGNOSTIC',locale,result,page.evaluate("({http:qaImageStatus,type:qaImageType,images:qaImages,calls:qaCalls.length,status:document.querySelector('#statusRegion').innerText,busy:state.busy})"),flush=True);raise
      if result=='success':page.evaluate('qaResolve({result:true})')
      else:page.evaluate('(s)=>qaReject(new Error(s))','user denied' if result=='cancel' else 'bridge failed')
      page.wait_for_function("!document.querySelector('#shareStory').disabled")
    assert page.evaluate('qaImages')==4 and page.evaluate('qaCalls.length')==4
    for order in ('story-first','busy-first'):
     for outcome in ('success','cancel','failure'):
      before=page.evaluate('qaCalls.length');image_before=page.evaluate('qaImages');button.click()
      page.wait_for_function('(n)=>qaImages===n+1',arg=image_before);page.evaluate('qaImageRelease()')
      page.wait_for_function('(before)=>qaCalls.length===before+1',arg=before)
      page.evaluate('setBusy(true)');assert button.is_disabled()
      if order=='busy-first':page.evaluate('setBusy(false)');assert button.is_disabled()
      page.evaluate("(outcome)=>outcome==='success'?qaResolve({result:true}):qaReject({error_data:{error_reason:outcome==='cancel'?'user denied':'native failed'}})",outcome)
      page.wait_for_function("document.querySelector('#shareStory').getAttribute('aria-disabled')==='false'")
      if order=='story-first':
       assert button.is_disabled();button.dispatch_event('click');assert page.evaluate('qaCalls.length')==before+1
       page.evaluate('setBusy(false)')
      assert button.is_enabled()
    assert not errors,errors
    print('PASS',locale,'single-flight real PNG/native; success/cancel/failure/retry + both global-busy completion orders; errors0',flush=True)
   finally:context.close()
 finally:browser.close()
