#!/usr/bin/env python3
"""Cold/error/recovery image lifecycle; isolated local app, no native claim."""
import os,time,base64,hashlib,hmac,urllib.parse
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
v={'vk_app_id':'54723764','vk_user_id':'81997615128','vk_platform':'mobile_android','vk_ts':str(int(time.time()))}
s=urllib.parse.urlencode(sorted(v.items()))
v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),s.encode(),hashlib.sha256).digest()).decode().rstrip('=')
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 try:
  for lang in ['ru','en']:
   c=b.new_context(viewport={'width':393,'height':852},service_workers='block')
   try:
    c.route('https://**/*',lambda r:r.abort())
    c.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,content_type='application/javascript',body='window.vkBridge={send:()=>Promise.resolve({}),supports:()=>true,subscribe:()=>{}};'))
    held=[];phase={'mode':'hold'}
    def image_route(r):
     if phase['mode']=='hold':held.append(r)
     elif phase['mode']=='fail':r.abort()
     else:r.continue_()
    c.route('**/assets/day-scene/*.webp*',image_route)
    p=c.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
    p.goto(BASE+'/?'+urllib.parse.urlencode(v),wait_until='domcontentloaded')
    p.wait_for_function('state.user&&!state.busy')
    p.evaluate('(l)=>{state.user.locale=l;KopilkaDayScene.render(["joy"],l)}',lang)
    p.wait_for_function('document.querySelector("[data-scene-type=joy] img")')
    pending=p.evaluate('''()=>[...document.querySelectorAll('.day-scene-picture img')].map(e=>({visible:getComputedStyle(e).visibility,natural:e.naturalWidth,complete:e.complete}))''')
    assert all(x['natural'] or x['visible']=='hidden' for x in pending),('unloaded image exposed',pending)
    height=p.locator('.day-scene-picture').bounding_box()['height'];assert height>100
    phase['mode']='fail'
    for r in list(held):r.abort()
    held.clear();p.wait_for_timeout(150)
    failed=p.evaluate('''()=>[...document.querySelectorAll('.day-scene-picture img')].map(e=>({visible:getComputedStyle(e).visibility,natural:e.naturalWidth}))''')
    assert all(x['natural'] or x['visible']=='hidden' for x in failed),('broken glyph exposed',failed)
    assert abs(p.locator('.day-scene-picture').bounding_box()['height']-height)<1
    assert p.locator('#daySceneDescription').inner_text()
    phase['mode']='recover'
    p.evaluate('(l)=>KopilkaDayScene.render(["joy"],l)',lang)
    p.wait_for_function('''()=>[...document.querySelectorAll('.day-scene-picture img')].every(e=>e.complete&&e.naturalWidth>0&&getComputedStyle(e).visibility==='visible')''')
    # Late load must not re-show a motif deselected in a later render.
    p.evaluate('(l)=>KopilkaDayScene.render([],l)',lang)
    assert p.locator('[data-scene-type=joy]').is_hidden()
    p.evaluate('(l)=>KopilkaDayScene.render(["joy"],l)',lang)
    assert p.locator('[data-scene-type=joy]').is_visible()
    assert not errors,errors
    print('PASS',lang,'cold/error images hidden, stable geometry, semantic fallback, retry recovery, selection preserved')
   finally:c.close()
 finally:b.close()
