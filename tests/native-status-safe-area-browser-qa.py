#!/usr/bin/env python3
import os,time,base64,hashlib,hmac,urllib.parse
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
def launch(platform):
 v={'vk_app_id':'54723764','vk_user_id':'81992044','vk_platform':platform,'vk_ts':str(int(time.time()))}
 v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),urllib.parse.urlencode(sorted(v.items())).encode(),hashlib.sha256).digest()).decode().rstrip('=')
 return urllib.parse.urlencode(v)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for platform in ['mobile_android','desktop_web']:
   c=b.new_context(viewport={'width':393,'height':852})
   try:
    c.route('https://**/*',lambda r:r.fulfill(status=200,body=''))
    c.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
    page=c.new_page();page.goto(BASE+'/?'+launch(platform));page.wait_for_function('state.user&&!state.busy',timeout=30000)
    page.evaluate("setStatus(L('ready'),'info','ready')")
    button=page.locator('#dismissStatus');button.wait_for(state='visible')
    rect=button.bounding_box();assert rect and (rect['y']>=64 if platform=='mobile_android' else rect['y']<64), (platform,rect)
    button.click();assert not page.locator('#statusRegion').inner_text()
    page.locator('#tab-button-profile').click();page.locator('#tab-button-today').click();assert not page.locator('#statusRegion').inner_text()
    page.evaluate("setStatus('QA error','error')");assert page.locator('#statusRegion').inner_text()=='QA error'
    print('PASS',platform,'safe native inset, center dismiss, no ready repeat, errors retained',flush=True)
   finally:c.close()
 finally:b.close()
