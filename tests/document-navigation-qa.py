#!/usr/bin/env python3
"""Real local browser navigation. Platform launches are signed fixtures, not live accounts."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import base64
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:3125'
BOT = 'fixture:document-navigation'

def signed_vk():
    fields = {'vk_app_id':'54723764', 'vk_user_id':'710072', 'vk_ts':str(int(time.time()))}
    check = urllib.parse.urlencode(sorted(fields.items()))
    fields['sign'] = base64.urlsafe_b64encode(hmac.new(b'document-fixture', check.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(fields)

def signed_tg():
    fields = {'auth_date':str(int(time.time())), 'user':json.dumps({'id':710073,'first_name':'Fixture'})}
    key = hmac.new(b'WebAppData', BOT.encode(), hashlib.sha256).digest()
    fields['hash'] = hmac.new(key, '\n'.join(f'{k}={v}' for k,v in sorted(fields.items())).encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(fields)

def main():
    with tempfile.TemporaryDirectory(prefix='kopilka-documents-') as tmp:
        for name in ['public','migrations']:
            Path(tmp,name).symlink_to(ROOT/name, target_is_directory=True)
        env = dict(os.environ, NODE_ENV='test', PORT='3125', DB_PATH=str(Path(tmp,'test.sqlite')),
            SESSION_SECRET='document-test', BOT_TOKEN=BOT, BOT_USERNAME='HarborLifeBot', VK_GROUP_TOKEN='',
            VK_APP_ID='54723764', VK_SECURE_KEY='document-fixture', VK_OAUTH_CLIENT_ID='',
            SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
        with open(Path(tmp,'server.log'),'w+') as log:
            proc = subprocess.Popen(['node',str(ROOT/'src/server.js')],cwd=tmp,env=env,stdout=log,stderr=log)
            try:
                deadline = time.monotonic()+15
                while True:
                    try:
                        urllib.request.urlopen(BASE+'/health',timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic()>deadline:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                with sync_playwright() as pw:
                    browser = pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800'))
                    try:
                        for surface in ['vk', 'telegram', 'web']:
                            ctx = browser.new_context(viewport={'width':390,'height':700}, has_touch=True)
                            errors=[]
                            ctx.on('page',lambda p:p.on('pageerror',lambda e:errors.append(str(e))))
                            ctx.route('https://**/*',lambda r:r.fulfill(status=200,body='',content_type='application/javascript'))
                            if surface == 'telegram':
                                ctx.add_init_script('window.Telegram={WebApp:{initData:'+json.dumps(signed_tg())+',ready(){},expand(){},onEvent(){}}};')
                            page=ctx.new_page()
                            url=BASE+'/?'+signed_vk() if surface=='vk' else BASE+'/'
                            try:
                                page.goto(url)
                                if surface != 'web':
                                    page.wait_for_function("document.querySelector('#connectionStatus').textContent.includes('Подключено')")
                                    page.locator('#entryNote').fill('Unsaved legal-reader regression draft')
                                    page.locator('#tab-button-settings').click()
                                    entry = '.legal-links'
                                else:
                                    page.locator('#loginScreen').wait_for(state='visible')
                                    entry = '#loginScreen'
                                page.emulate_media(reduced_motion='reduce')
                                page.evaluate("window.__appDocument=document;window.__appShell=document.querySelector('.app-shell');window.__draft=document.querySelector('#entryNote');window.__storage=JSON.stringify({...localStorage});window.__session=JSON.stringify({...sessionStorage})")
                                navigations=[]
                                page.on('framenavigated',lambda f:navigations.append(f.url))
                                fetches=[]
                                page.on('request',lambda r:fetches.append(r) if urllib.parse.urlparse(r.url).path in ['/privacy.html','/terms.html'] else None)
                                for width in [390,760]:
                                    page.set_viewport_size({'width':width,'height':700})
                                    for doc,other in [('privacy','terms'),('terms','privacy')]:
                                        for action in ['close','escape','back','return']:
                                            link=page.locator(entry+' a[href="/'+doc+'.html"]')
                                            link.scroll_into_view_if_needed()
                                            link.focus()
                                            before=page.evaluate('({x:scrollX,y:scrollY,tab:document.querySelector(".tab-bar [aria-selected=true]")?.id})')
                                            page.evaluate('window.__opener=document.activeElement')
                                            if action=='escape':
                                                link.press('Enter')
                                            elif action=='close' and width==390:
                                                link.tap()
                                            else:
                                                link.click()
                                            dialog=page.get_by_role('dialog')
                                            heading=dialog.locator('h1')
                                            heading.wait_for()
                                            assert page.url==url
                                            assert page.evaluate('document.activeElement===document.querySelector(".document-content h1")')
                                            # Native modal keeps underlying app controls inert and Tab inside.
                                            for _ in range(7):
                                                page.keyboard.press('Tab')
                                                assert page.evaluate('document.querySelector("dialog").contains(document.activeElement)')
                                            page.keyboard.press('Shift+Tab')
                                            assert page.evaluate('document.querySelector("dialog").contains(document.activeElement)')
                                            canonical=ctx.request.get(BASE+'/'+doc+'.html').text()
                                            expected=page.evaluate('(html)=>Array.from(new DOMParser().parseFromString(html,"text/html").querySelectorAll("main h1,main h2,main li,main p")).map(n=>n.textContent.trim()).slice(0,-1)',canonical)
                                            actual=dialog.locator('h1,h2,li,p').evaluate_all('(nodes)=>nodes.map(n=>n.textContent.trim()).slice(0,-1)')
                                            assert actual==expected,'Legal copy changed'
                                            dialog.locator('a[href="/'+other+'.html"]').click()
                                            page.wait_for_function('(name)=>document.querySelector("dialog h1")?.textContent.includes(name)',arg='Условия' if other=='terms' else 'Политика')
                                            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                                            if action=='close':
                                                dialog.get_by_role('button',name='Закрыть документ').click()
                                            elif action=='escape':
                                                page.keyboard.press('Escape')
                                            elif action=='back':
                                                page.go_back()
                                            else:
                                                dialog.get_by_role('button',name='Вернуться в приложение').click()
                                            dialog.wait_for(state='hidden')
                                            page.wait_for_timeout(50)
                                            assert page.evaluate('document===window.__appDocument && document.querySelector(".app-shell")===window.__appShell && document.querySelector("#entryNote")===window.__draft')
                                            assert page.evaluate('document.activeElement===window.__opener')
                                            assert page.evaluate('JSON.stringify({...localStorage})===window.__storage && JSON.stringify({...sessionStorage})===window.__session')
                                            after=page.evaluate('({x:scrollX,y:scrollY,tab:document.querySelector(".tab-bar [aria-selected=true]")?.id})')
                                            assert before==after,(before,after)
                                            if surface!='web':
                                                assert page.locator('#entryNote').input_value()=='Unsaved legal-reader regression draft'
                                # Browser Forward reopens the same embedded reader, Back closes it again.
                                page.go_forward()
                                page.get_by_role('dialog').locator('h1').wait_for()
                                page.go_back()
                                page.get_by_role('dialog').wait_for(state='hidden')
                                for mode in ['http','invalid','network']:
                                    def fail(route):
                                        if mode=='network': route.abort()
                                        else: route.fulfill(status=503 if mode=='http' else 200,body='<main>Not a document</main>',content_type='text/html')
                                    page.route('**/privacy.html',fail)
                                    page.locator(entry+' a[href="/privacy.html"]').click()
                                    page.get_by_role('alert').filter(has_text='Не удалось загрузить').wait_for()
                                    assert page.url==url
                                    page.unroute('**/privacy.html',fail)
                                    page.get_by_role('button',name='Повторить загрузку').click()
                                    page.get_by_role('dialog').locator('h1').wait_for()
                                    page.get_by_role('button',name='Закрыть документ').click()
                                    page.get_by_role('dialog').wait_for(state='hidden')
                                # Closing a still-pending fetch must not reopen or replace the app later.
                                pending=[]
                                page.route('**/privacy.html',lambda route:pending.append(route))
                                link=page.locator(entry+' a[href="/privacy.html"]')
                                link.evaluate('el=>{el.href="/privacy.html?sign=DO_NOT_FORWARD&return=https://evil.example";el.target="_blank"}')
                                page.locator(entry+' a[href^="/privacy.html?"]').tap()
                                page.get_by_role('dialog').wait_for()
                                page.wait_for_function('document.querySelector(".document-content").getAttribute("aria-busy")==="true"')
                                page.get_by_role('button',name='Закрыть документ').click()
                                page.get_by_role('dialog').wait_for(state='hidden')
                                for route in pending: route.abort()
                                page.unroute('**/privacy.html')
                                page.wait_for_timeout(100)
                                assert not page.get_by_role('dialog').is_visible()
                                assert page.evaluate('document===window.__appDocument')
                                assert page.url==url and all(u==url for u in navigations)
                                assert len(ctx.pages)==1,'Document opened another window'
                                assert fetches
                                for req in fetches:
                                    assert urllib.parse.urlparse(req.url).query==''
                                    headers=req.all_headers()
                                    assert not any(k in headers for k in ['referer','cookie','authorization']),headers.keys()
                                    assert not req.is_navigation_request()
                                # Standalone pages / reload / cross-links still work, untrusted return ignored.
                                extra=ctx.new_page()
                                for doc in ['privacy','terms']:
                                    extra.goto(BASE+'/'+doc+'.html?source=https://evil.example&return=https://evil.example')
                                    extra.reload()
                                    assert extra.locator('main h1').is_visible()
                                    assert extra.get_by_role('link',name='Вернуться в приложение').get_attribute('href')==BASE+'/'
                                    extra.locator('main a[href^="/'+('terms' if doc=='privacy' else 'privacy')+'.html"]').click()
                                    assert extra.locator('main h1').is_visible()
                                extra.close()
                                assert not errors,errors
                                print('PASS',surface,'390/760px: both documents, full canonical copy, internal cross-links, 4 close paths, keyboard/focus, same DOM/tab/draft/scroll/storage, forward, HTTP/invalid/network retry, no external navigation/new tabs/credential forwarding; standalone; JS errors=0')
                            finally:
                                ctx.close()
                    finally:
                        browser.close()
            finally:
                proc.terminate()
                proc.wait(timeout=10)

if __name__=='__main__':
    main()
