#!/usr/bin/env python3
"""Early boot integration, isolated DB/server and real pinned SDK; no provider traffic."""
import os, time, base64, hashlib, hmac, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ['KOPILKA_QA_BASE_URL']
assert os.environ['NODE_ENV']=='test' and 'qa.sqlite' in os.environ['DB_PATH']
def launch():
 v={'vk_app_id':'54723764','vk_user_id':'81991008','vk_ts':str(int(time.time()))}
 text=urllib.parse.urlencode(sorted(v.items()))
 v['sign']=base64.urlsafe_b64encode(hmac.new(os.environ['VK_SECURE_KEY'].encode(),text.encode(),hashlib.sha256).digest()).decode().rstrip('=')
 return urllib.parse.urlencode(v)
with sync_playwright() as pw:
 browser=pw.chromium.connect_over_cdp(os.environ['KOPILKA_QA_CDP_URL'])
 def context():
  ctx=browser.new_context(viewport={'width':390,'height':844})
  ctx.route('https://**/*',lambda r:r.fulfill(status=200,body='',content_type='application/javascript'))
  return ctx
 # An absent app.js must leave accessible recovery, in both languages.
 for lang in ['ru','en']:
  ctx=context()
  try:
   ctx.route('**/app.js?*',lambda r:r.abort())
   page=ctx.new_page();page.goto(BASE+'/?lang='+lang)
   page.locator('#startupScreen').wait_for(state='visible')
   page.wait_for_function('document.getElementById("startupMessage").textContent.includes("could not")' if lang=='en' else 'document.getElementById("startupMessage").textContent.includes("Не удалось")')
   assert page.locator('#startupReload').is_enabled()
   assert page.locator('#appShell').is_hidden() and page.locator('#loginScreen').is_hidden()
  finally:ctx.close()
 # The fallback itself must survive failure of the guard resource.
 ctx=context()
 try:
  ctx.route('**/startup.js?*',lambda r:r.abort());ctx.route('**/app.js?*',lambda r:r.abort())
  page=ctx.new_page();page.goto(BASE+'/');assert page.locator('#startupScreen').is_visible();assert page.locator('#startupReload').is_enabled()
 finally:ctx.close()
 # Actual pinned SDK sees iOS handlers late; recovery calls current native handler once.
 ctx=context()
 try:
  sdk=Path('public/vendor/vk-bridge-3.0.2.min.js').read_text()
  injected=sdk+'\n'+''';window.nativeInitCount=0;setTimeout(function(){window.webkit={messageHandlers:{VKWebAppClose:{postMessage:function(){}},VKWebAppInit:{postMessage:function(){window.nativeInitCount++;}}}};},200);'''
  ctx.route('**/vendor/vk-bridge*',lambda r:r.fulfill(status=200,body=injected,content_type='application/javascript'))
  page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(BASE+'/?'+launch());page.wait_for_function('state.user && state.summary && !state.busy')
  try: page.wait_for_function('window.nativeInitCount===1',timeout=6000)
  except Exception:
   print('NATIVE_DIAGNOSTIC',page.evaluate('({count:window.nativeInitCount,webview:window.vkBridge?.isWebView(),handler:!!window.webkit?.messageHandlers?.VKWebAppInit,guard:!!window.KopilkaStartup})'))
   raise
  assert page.evaluate('window.vkBridge.isWebView()') is False
  assert page.locator('#startupScreen').is_hidden();assert not errors,errors
 finally:ctx.close()
 # A stalled deferred Telegram SDK must not gate the immediate VK bootstrap.
 ctx=context()
 try:
  held=[];ctx.route('https://telegram.org/js/telegram-web-app.js',lambda r:held.append(r))
  page=ctx.new_page();page.goto(BASE+'/?'+launch(),wait_until='commit')
  page.wait_for_function('typeof state!=="undefined" && state.user && state.summary && !state.busy',timeout=20000)
  assert page.locator('#startupScreen').is_hidden();assert page.evaluate('document.readyState')!='complete'
  for route in held:route.fulfill(status=200,body='',content_type='application/javascript')
  page.wait_for_load_state()
 finally:ctx.close()
 # Native handlers are present before a deliberately delayed SDK. No guard Init is permitted.
 ctx=context()
 try:
  ctx.add_cookies([{'name':'qa_only_cookie','value':'fixture','url':BASE}])
  ctx.add_init_script('''window.nativeCalls=[];window.webkit={messageHandlers:{VKWebAppClose:{postMessage(){}},VKWebAppInit:{postMessage(p){nativeCalls.push({sdk:!!window.vkBridge,params:p});window.dispatchEvent(new CustomEvent('VKWebAppEvent',{detail:{type:'VKWebAppInitResult',data:{request_id:p.request_id,result:true}}}));}}}};''')
  def delayed_sdk(route):
   time.sleep(.4);route.fulfill(status=200,body=sdk,content_type='application/javascript')
  ctx.route('**/vendor/vk-bridge-3.0.2.min.js*',delayed_sdk)
  requests=[];page=ctx.new_page();page.on('request',lambda request:requests.append(request) if '/api/client-log' in request.url else None)
  page.goto(BASE+'/?'+launch());page.wait_for_function('state.user && state.summary && !state.busy')
  calls=page.evaluate('window.nativeCalls');assert calls and all(call['sdk'] for call in calls)
  page.wait_for_timeout(500)
  assert requests
  for request in requests:
   headers=request.all_headers()
   assert not any(key in headers for key in ['referer','cookie','authorization']), {'event': __import__('json').loads(request.post_data or '{}').get('event'), 'keys': list(headers)}
   assert 'sign=' not in (request.post_data or '')
   assert 'startup_init-native-recovery' not in (request.post_data or '')
 finally:ctx.close()
 # Ordinary website remains usable with no native recovery and no duplicate screen.
 ctx=context()
 try:
  page=ctx.new_page();page.goto(BASE+'/');page.locator('#loginScreen').wait_for(state='visible');assert page.locator('#startupScreen').is_hidden()
 finally:ctx.close()
 print('STARTUP_CONNECTED_PASS: blocked app RU/EN, guard absent static fallback, actual pinned SDK late native recovery once, signed auth retained, ordinary website, JS errors0 in healthy native scenario')
