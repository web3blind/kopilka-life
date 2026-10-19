#!/usr/bin/env python3
"""Connected isolated HTTP/SQLite/CDP checks; native host/provider are stand-ins."""
import base64
import hashlib
import hmac
import http.server
import threading
import json
import os
import sqlite3
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']

def launch(user, age=0, lang='ru'):
    fields = dict(vk_app_id='54723764', vk_user_id=str(user), vk_ts=str(int(time.time())-age), vk_language=lang)
    check = '&'.join(k+'='+fields[k] for k in sorted(fields))
    fields['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return '?' + urllib.parse.urlencode(fields)

def main():
    results = []
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL', 'http://127.0.0.1:18800'))
        owned = []
        def context():
            ctx = browser.new_context(); owned.append(ctx)
            def route(r):
                url = r.request.url
                if 'vk-bridge' in url: r.fulfill(content_type='application/javascript', body='/* host fixture */')
                elif url.startswith(BASE+'/'): r.continue_()
                elif url.startswith('http://127.0.0.1:32992/authorize?'): r.continue_()
                else: r.abort()
            ctx.route('**/*', route)
            return ctx
        def auth(ctx, user, lang='ru'):
            r = ctx.request.post(BASE+'/api/auth/vk', data={'launchParams':launch(user, lang=lang)})
            assert r.status == 200, r.text()
            return r.json()
        def seed(page, token='', fresh=''):
            page.add_init_script('''args => {
              localStorage.clear(); if(args.token)localStorage.setItem('kopilkaToken',args.token);
              window.bridgeCalls=[]; window.vkBridge={isWebView:()=>true,send:async method=>{bridgeCalls.push(method);return method==='VKWebAppGetLaunchParams' ? args.fresh : {result:true};}};
            }'''.replace('args => {', '(() => {const args='+json.dumps(dict(token=token,fresh=fresh))+';').replace('\n            }', '\n            })();'))
        def identity(page, vk):
            page.wait_for_function('state.user !== null')
            with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro', uri=True) as db:
                actual = db.execute('SELECT vk_id FROM users WHERE id=?', (page.evaluate('state.user.id'),)).fetchone()
            assert actual == (str(vk),), actual
        try:
            for lang in ['ru','en']:
                ctx=context(); avk,bvk=(92001,92002) if lang=='ru' else (92011,92012); a=auth(ctx,avk,lang); b=auth(ctx,bvk,lang)
                for label, token, proof, fresh, expected in [
                    ('same stale continuation',a['token'],launch(avk,5184000,lang),'',avk),
                    ('fresh B priority',a['token'],launch(bvk,0,lang),'',bvk),
                    ('fresh bridge B priority',a['token'],launch(avk,5184000,lang),launch(bvk,0,lang),bvk),
                    ('stale B isolates A',a['token'],launch(bvk,5184000,lang),'',None),
                    ('bad signature isolates A',a['token'],launch(avk,5184000,lang)+'x','',None),
                ]:
                    page=ctx.new_page(); seed(page,token,fresh); requests=[]
                    page.on('request',lambda r: requests.append((urllib.parse.urlsplit(r.url).path,r.headers.get('authorization',''))))
                    page.goto(BASE+'/'+proof,wait_until='domcontentloaded')
                    if expected: page.wait_for_function('state.user !== null')
                    page.locator('#appShell' if expected else '#loginScreen').wait_for(state='visible')
                    if expected:
                        identity(page,expected)
                        if label=='same stale continuation': assert page.evaluate('state.token')==token
                        assert page.evaluate('locale()')==lang
                    else:
                        assert not any(path in ['/api/me','/api/summary','/api/history'] for path,_ in requests), requests
                    if label=='same stale continuation':
                        paths=[path for path,_ in requests]; assert paths.index('/api/auth/vk/resume') < paths.index('/api/me')
                        assert page.evaluate('bridgeCalls.includes("VKWebAppGetLaunchParams")')
                        page.locator('#entryNote').fill('draft preserved')
                        page.evaluate('handleVkAuth()'); assert page.locator('#entryNote').input_value()=='draft preserved'
                    results.append(lang+': '+label); page.close()
                ctx.close();owned.remove(ctx)
            for path in ['/', '/?vk_app_id=54723764&vk_user_id=1&sign=invalid']:
                # Desktop popup keeps correlated exact-source handoff; no automatic OAuth.
                ctx=context(); page=ctx.new_page();seed(page)
                page.goto(BASE+path)
                page.locator('#loginScreen').wait_for(state='visible');assert len(ctx.pages)==1
                with page.expect_popup() as pop: page.locator('#vkLoginButton').click()
                popup=pop.value
                page.locator('#appShell').wait_for(state='visible');identity(page,92003)
                page.wait_for_function('state.vkOAuthWindow===null');assert popup.is_closed()
                results.append('explicit auth + exact-source handoff '+path)
                ctx.close();owned.remove(ctx)
            # Native reparent stand-in: live WindowProxy exists but navigation is
            # ignored; independent external context has neither name nor opener.
            ctx=context();page=ctx.new_page();seed(page)
            page.goto(BASE+'/?vk_app_id=54723764&vk_user_id=1&sign=invalid')
            page.locator('#loginScreen').wait_for(state='visible')
            page.evaluate("window.open=(url,name)=>{window.openedName=name;return {closed:false,location:{replace(){}},close(){}}}")
            page.locator('#vkLoginButton').click();link=page.locator('#loginStatus a');link.wait_for(state='visible')
            url=link.get_attribute('href');assert url and urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).keys()=={'intent'}
            assert page.evaluate('openedName')=='_blank' and page.evaluate('state.vkOAuthWindow.closed') is False
            external=context();external_page=external.new_page();seed(external_page)
            external_page.goto(url);external_page.locator('#appShell').wait_for(state='visible');identity(external_page,92003)
            assert external_page.evaluate('window.opener===null && window.name===""')
            assert page.evaluate('state.token')==''
            assert external.request.get(url).status==400,'intent one-use'
            results.append('external browser lost name/opener + live proxy explicit fallback + one-use')
            # Normal link stays on original authenticated account; server finalizes.
            ctx=context();created=ctx.request.post(BASE+'/api/auth/dev',data={'firstName':'Link fixture'}).json()
            page=ctx.new_page();seed(page,created['token']);page.goto(BASE);page.wait_for_function('state.user !== null');page.locator('#appShell').wait_for(state='visible')
            page.on('response',lambda r: print('LINK_HTTP',urllib.parse.urlsplit(r.url).path,r.status,flush=True) if '/api/auth/vk-oauth/' in r.url else None)
            with page.expect_popup() as pop: page.evaluate("startVkOAuth('link',document.getElementById('vkLinkStatus'))")
            page.wait_for_function('state.vkOAuthWindow===null')
            page.wait_for_function('state.user?.vkLinked === true')
            with sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True) as db:
                current=db.execute('SELECT vk_id FROM users WHERE id=?',(created['user']['id'],)).fetchone()[0]
                assert current == '92003'
            assert page.evaluate('state.user.id')==created['user']['id']
            results.append('explicit link: authenticated finalize retains initiating account')
            print(json.dumps({'passed':len(results),'results':results},ensure_ascii=False,indent=2),flush=True)
        finally:
            for ctx in owned: ctx.close()

if __name__=='__main__':
    class Provider(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            assert q['redirect_uri']==[BASE+'/api/auth/vk-oauth/callback']
            assert q['code_challenge_method']==['S256'] and len(q['code_challenge'][0])==43
            target=q['redirect_uri'][0]+'?'+urllib.parse.urlencode(dict(state=q['state'][0],code='fixture-code',device_id='fixture-device'))
            self.send_response(302);self.send_header('Location',target);self.end_headers()
        def log_message(self,format,*args): pass
    with http.server.ThreadingHTTPServer(('127.0.0.1',32992),Provider) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try: main()
        finally: server.shutdown();thread.join()
