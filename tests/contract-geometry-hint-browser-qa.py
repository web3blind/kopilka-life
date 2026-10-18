#!/usr/bin/env python3
"""Local connected geometry and accessible custom-unit hint regression."""
import os,time,base64,hashlib,hmac,urllib.parse
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
v={'vk_app_id':'54723764','vk_user_id':'81992118','vk_platform':'mobile_android','vk_ts':str(int(time.time()))}
v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(v.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for language in ['ru','en']:
   for viewport in [{'width':393,'height':852},{'width':1280,'height':800}]:
    c=b.new_context(viewport=viewport)
    try:
     c.route('https://**/*',lambda r:r.fulfill(status=200,body=''))
     c.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
     p=c.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
     p.goto(BASE+'/?'+urllib.parse.urlencode(v));p.wait_for_function('state.user&&!state.busy')
     p.evaluate('(lang)=>{state.user.locale=lang;renderAll()}',language)
     p.locator('#tab-button-contract').click()
     target=p.locator('#contractTarget');target.fill('x'*300)
     target.evaluate('(e)=>{e.style.height="4000px"}')
     geometry=target.evaluate('(e)=>({height:e.getBoundingClientRect().height,max:getComputedStyle(e).maxHeight,overflow:getComputedStyle(e).overflowY,scroll:e.scrollHeight,client:e.clientHeight})')
     assert geometry['height']<=viewport['height']*.5+1,geometry
     assert geometry['overflow']=='auto',geometry
     assert target.input_value()=='x'*300
     currency=p.locator('#stakeCurrency');currency.fill('баллы заботы' if language=='ru' else 'care points')
     assert 'stakeCurrencyHint' in currency.get_attribute('aria-describedby').split()
     hint=p.locator('#stakeCurrencyHint');assert hint.is_visible()
     assert ('20' in hint.inner_text()) and ('баллы' in hint.inner_text() if language=='ru' else 'points' in hint.inner_text())
     p.locator('#contractTitle').fill('Geometry fixture')
     p.locator('#contractForm button[type=submit]').click()
     p.wait_for_function('state.currentContract')
     assert p.evaluate('state.currentContract.stake_currency')==('баллы заботы' if language=='ru' else 'care points')
     assert not errors,errors
     # A separate fixture user for the next viewport keeps the real create route.
     v['vk_user_id']=str(int(v['vk_user_id'])+1)
     v.pop('sign');v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(v.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
     print('PASS',language,viewport,'bounded textarea, full text retained, accessible hint, custom unit saved through real API')
    finally:c.close()
 finally:b.close()
