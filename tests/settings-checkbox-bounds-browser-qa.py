#!/usr/bin/env python3
"""Settings native checkbox bounds and keyboard state, fixture account only."""
import os,time,base64,hashlib,hmac,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
v={'vk_app_id':'54723764','vk_user_id':'8199761953','vk_platform':'mobile_android','vk_ts':str(int(time.time()))}
s=urllib.parse.urlencode(sorted(v.items()))
v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),s.encode(),hashlib.sha256).digest()).decode().rstrip('=')
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  c=b.new_context(viewport={'width':393,'height':852})
  try:
   c.route('https://**/*',lambda r:r.abort())
   c.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
   p=c.new_page();p.goto(BASE+'/?'+urllib.parse.urlencode(v));p.wait_for_function('state.user&&!state.busy')
   p.locator('#tab-button-settings').click()
   checkbox=p.locator('.checkbox-label input[type=checkbox]').first
   metrics=checkbox.evaluate('''e=>{const s=getComputedStyle(e);return {width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,paddingTop:parseFloat(s.paddingTop),paddingBottom:parseFloat(s.paddingBottom),paddingLeft:parseFloat(s.paddingLeft),paddingRight:parseFloat(s.paddingRight),appearance:s.appearance}}''')
   print('CHECKBOX_METRICS',metrics)
   assert metrics['paddingTop']+metrics['paddingBottom']<metrics['height']-2,('native checkbox content box clipped',metrics)
   assert all(metrics[k]==0 for k in ['paddingTop','paddingBottom','paddingLeft','paddingRight']),metrics
   before=checkbox.is_checked();checkbox.focus();checkbox.press('Space');assert checkbox.is_checked()!=before
   assert checkbox.evaluate('e=>document.activeElement===e')
   assert p.locator('label[for="'+checkbox.get_attribute('id')+'"]').count() or checkbox.locator('xpath=ancestor::label').count()
   checkbox.press('Space');assert checkbox.is_checked()==before
   print('PASS checkbox content bounds, associated label, keyboard state and focus; no settings submitted')
  finally:c.close()
 finally:b.close()
