#!/usr/bin/env python3
"""Own HTTP limiter only; no VK/provider requests or quotas."""
import os, time, json, urllib.request, urllib.error, sqlite3
from playwright.sync_api import sync_playwright
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
from importlib.machinery import SourceFileLoader
launch = SourceFileLoader('native_fixture', str(Path(__file__).with_name('vk-native-recovery-browser-qa.py'))).load_module().launch
BASE = os.environ['KOPILKA_QA_BASE_URL']
def exhaust():
    for _ in range(2):
        try:
            urllib.request.urlopen(urllib.request.Request(BASE+'/api/auth/vk', data=b'{}', headers={'Content-Type':'application/json'}))
        except urllib.error.HTTPError: pass
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    for lang in ['ru','en']:
        time.sleep(3.1)
        exhaust()
        # Actual isolated HTTP throttle, not a fulfilled browser response.
        with sqlite3.connect(os.environ['DB_PATH']) as db:
            before = list(db.iterdump())
        req=urllib.request.Request(BASE+'/api/auth/vk-oauth/intent',data=b'{"action":"auth"}',headers={'Content-Type':'application/json'})
        try:
            urllib.request.urlopen(req)
            raise AssertionError('intent must remain protected')
        except urllib.error.HTTPError as e:
            assert e.code==429 and int(e.headers['Retry-After'])>0
        with sqlite3.connect(os.environ['DB_PATH']) as db:
            assert list(db.iterdump())==before, 'rejected intent must not change account data'
        try: urllib.request.urlopen(BASE+'/api/auth/vk-oauth/window')
        except urllib.error.HTTPError as e:
            assert e.code==429
            assert int(e.headers['Retry-After'])>0
            assert 'text/html' in e.headers['Content-Type'], e.headers['Content-Type']
            assert 'no-store' in e.headers['Cache-Control']
        ctx=browser.new_context()
        ctx.route('**/*vk-bridge*',lambda r:r.fulfill(content_type='application/javascript',body=''))
        ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+');window.vkBridge={isWebView:()=>true,send:async()=>({result:true})};')
        page=ctx.new_page()
        page.goto(BASE+launch(lang,991111,expired=False))
        page.locator('#loginScreen').wait_for(state='visible')
        assert page.locator('#vkLoginButton').is_disabled()
        assert ('Too many' if lang=='en' else 'Слишком много') in page.locator('#loginStatus').inner_text()
        page.evaluate('startVkOAuth()')
        assert len(ctx.pages)==1
        page.wait_for_function('!document.getElementById("vkLoginButton").disabled')
        page.locator('#vkLoginButton').click()
        page.locator('#appShell').wait_for(state='visible')
        page.wait_for_function('state.user && state.summary && state.token')
        with sqlite3.connect(os.environ['DB_PATH']) as db:
            assert db.execute('SELECT vk_id FROM users WHERE id=?', (page.evaluate('state.user.id'),)).fetchone()==('991111',)
        assert len(ctx.pages)==1
        ctx.close()
        time.sleep(3.1)
        ctx=browser.new_context()
        ctx.route('**/*vk-bridge*',lambda r:r.fulfill(content_type='application/javascript',body=''))
        ctx.add_init_script('localStorage.setItem("kopilkaLocale",'+json.dumps(lang)+');')
        page=ctx.new_page();page.goto(BASE)
        page.locator('#vkLoginButton').wait_for(state='visible')
        exhaust()
        with page.expect_popup() as opened: page.locator('#vkLoginButton').click()
        popup=opened.value
        popup.wait_for_load_state()
        assert ('Too many' if lang=='en' else 'Слишком много') in popup.locator('#status').inner_text()
        page.wait_for_function('state.vkOAuthWindow===null && state.vkOAuthChannel===""')
        assert page.locator('#vkLoginButton').is_disabled()
        assert page.evaluate('state.token')==''
        page.evaluate("receiveVkOAuthHandoff({origin:'https://other.invalid',source:null,data:{type:'kopilka:vk-oauth',channel:'',action:'',token:'forged'}})")
        page.evaluate("receiveVkOAuthHandoff({origin:location.origin,source:null,data:{type:'kopilka:vk-oauth',channel:'',action:'',token:'late'}})")
        assert page.evaluate('state.token')==''
        page.wait_for_function('!document.getElementById("vkLoginButton").disabled')
        assert page.locator('#loginStatus').inner_text()==('Можно повторить вход.' if lang=='ru' else 'You can try signing in again.')
        page.evaluate("""() => {
          const fake={closed:false,postMessage:()=>{}};
          state.vkOAuthWindow=fake;state.vkOAuthChannel='a'.repeat(48);state.vkOAuthAction='auth';
          const data={type:'kopilka:vk-oauth',action:'auth',channel:state.vkOAuthChannel,error:'forged',retryAfter:900};
          receiveVkOAuthHandoff({origin:'https://invalid.example',source:fake,data});
          receiveVkOAuthHandoff({origin:location.origin,source:window,data});
          receiveVkOAuthHandoff({origin:location.origin,source:fake,data:{...data,channel:'b'.repeat(48)}});
          receiveVkOAuthHandoff({origin:location.origin,source:fake,data:{...data,action:'link'}});
        }""")
        assert page.evaluate("!vkAuthCoolingDown() && state.vkOAuthChannel==='a'.repeat(48)")
        page.evaluate('clearVkOAuthPending()')
        ctx.close()
        print('PASS',lang,'real startup429/window429 HTML, cooldown/no popup, expiry/signed retry, stale/cross-origin fences')
    browser.close()
