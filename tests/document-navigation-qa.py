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
                        for surface,target in [('vk','https://vk.ru/app54723764'),('telegram','https://t.me/HarborLifeBot?startapp'),('web',BASE+'/')]:
                            ctx = browser.new_context(viewport={'width':390,'height':700})
                            errors=[]
                            ctx.on('page',lambda p:p.on('pageerror',lambda e:errors.append(str(e))))
                            ctx.route('https://**/*',lambda r:r.fulfill(status=200,body='',content_type='application/javascript'))
                            if surface == 'telegram':
                                ctx.add_init_script('window.Telegram={WebApp:{initData:'+json.dumps(signed_tg())+',ready(){},expand(){},onEvent(){}}};')
                            page=ctx.new_page()
                            url=BASE+'/?'+signed_vk() if surface=='vk' else BASE+'/'
                            for doc,other in [('privacy','terms'),('terms','privacy')]:
                                page.goto(url)
                                if surface!='web':
                                    page.wait_for_function("document.querySelector('#connectionStatus').textContent.includes('Подключено')")
                                    page.locator('#tab-button-settings').click()
                                    link=page.locator('.legal-links a[href^="/'+doc+'.html"]')
                                else:
                                    page.locator('#loginScreen').wait_for(state='visible')
                                    link=page.locator('#loginScreen a[href^="/'+doc+'.html"]')
                                # Href works even when opened in a separate tab, not only with a click handler.
                                href=link.get_attribute('href')
                                assert href is not None
                                assert href == '/'+doc+'.html?source='+surface, (surface,href)
                                link.click()
                                page.wait_for_url('**/'+doc+'.html?source='+surface)
                                page.reload()
                                assert page.get_by_role('link',name='Вернуться в приложение').get_attribute('href')==target
                                page.locator('a[href^="/'+other+'.html"]').click()
                                page.wait_for_url('**/'+other+'.html?source='+surface)
                                extra=ctx.new_page()
                                extra.goto(BASE+href)
                                assert extra.get_by_role('link',name='Вернуться в приложение').get_attribute('href')==target
                                extra.close()
                                if surface!='web':
                                    page.route(target,lambda r:r.fulfill(status=200,body='<h1>Platform destination fixture</h1>',content_type='text/html'))
                                page.get_by_role('link',name='Вернуться в приложение').click()
                                page.wait_for_url(target)
                            # The same return must escape a host iframe on a real user click.
                            if surface != 'web':
                                page.goto(BASE+'/privacy.html?source='+surface)
                                page.set_content('<iframe title="Document frame" src="'+BASE+'/terms.html?source='+surface+'"></iframe>')
                                frame=page.frame_locator('iframe')
                                frame.get_by_role('link',name='Вернуться в приложение').click()
                                page.wait_for_url(target)
                            page.goto(BASE+'/privacy.html?source=vk&source=telegram')
                            assert page.get_by_role('link',name='Вернуться в приложение').get_attribute('href')==BASE+'/'
                            for source in ['https://evil.example','javascript:alert(1)','vk&source=telegram','']:
                                page.goto(BASE+'/privacy.html?source='+urllib.parse.quote(source)+'&return=https://evil.example')
                                assert page.get_by_role('link',name='Вернуться в приложение').get_attribute('href')==BASE+'/'
                            assert not errors,errors
                            print('PASS',surface,'both document entries/cross-links/reload/new tab/click return; invalid source safe; JS errors=0')
                            ctx.close()
                    finally:
                        browser.close()
            finally:
                proc.terminate()
                proc.wait(timeout=10)

if __name__=='__main__':
    main()
