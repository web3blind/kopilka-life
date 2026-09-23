#!/usr/bin/env python3
"""Real local app/UI + SQLite; native bridge responses are controlled, never live VK."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:3126'


def launch(user):
    p = {'vk_app_id': '54723764', 'vk_user_id': str(user), 'vk_ts': str(int(time.time()))}
    p['sign'] = base64.urlsafe_b64encode(hmac.new(b'support-fixture', urllib.parse.urlencode(sorted(p.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return urllib.parse.urlencode(p)


BRIDGE = '''window.copyCalls=[];window.copyMode='pending';window.shareMode='success';window.vkBridge={
 send(method,params){
  if(method==='VKWebAppCopyText'){
   window.copyCalls.push(params);
   if(window.copyMode==='reject')return Promise.reject({error_data:{error_code:4}});
   if(window.copyMode==='false')return Promise.resolve({result:false});
   return new Promise(resolve=>window.resolveCopy=resolve);
  }
  if(method==='VKWebAppShare'){
   if(window.shareMode==='reject')return Promise.reject({error_data:{error_code:4}});
   return Promise.resolve({result:true});
  }
  return Promise.resolve({});
 },subscribe(){},supports(){return true}
};'''


def main():
    with tempfile.TemporaryDirectory(prefix='kopilka-share-') as tmp:
        for name in ['public', 'migrations']:
            Path(tmp, name).symlink_to(ROOT/name, target_is_directory=True)
        db_path = Path(tmp, 'test.sqlite')
        env = dict(os.environ, NODE_ENV='test', PORT='3126', DB_PATH=str(db_path),
            SESSION_SECRET='share-fixture-session', BOT_TOKEN='', VK_GROUP_TOKEN='',
            VK_APP_ID='54723764', VK_SECURE_KEY='support-fixture', VK_OAUTH_CLIENT_ID='',
            SCHEDULER_ENABLED='false', DEV_AUTH_ENABLED='false', APP_BASE_URL=BASE, WEBAPP_URL=BASE)
        with open(Path(tmp, 'server.log'), 'w+') as log:
            proc = subprocess.Popen(['node', str(ROOT/'src/server.js')], cwd=tmp, env=env, stdout=log, stderr=log)
            try:
                end = time.monotonic()+15
                while True:
                    try:
                        urllib.request.urlopen(BASE+'/health', timeout=1).close()
                        break
                    except Exception:
                        if proc.poll() is not None or time.monotonic()>end:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        time.sleep(.1)
                with sync_playwright() as pw:
                    browser = pw.chromium.connect_over_cdp('http://127.0.0.1:18800')
                    ctx = browser.new_context()
                    try:
                        ctx.route('https://**/*', lambda r: r.fulfill(status=200, body='', content_type='application/javascript'))
                        ctx.route('**/vendor/vk-bridge*', lambda r: r.fulfill(status=200, body=BRIDGE, content_type='application/javascript'))
                        page = ctx.new_page(); errors=[]; posts=[]
                        page.on('pageerror', lambda e: errors.append(str(e)))
                        page.on('request', lambda r: posts.append(r.url) if r.method=='POST' and '/support/actions/' in r.url else None)
                        page.goto(BASE+'/?'+launch(710081))
                        page.wait_for_function("document.querySelector('#connectionStatus').textContent.includes('Подключено')")
                        page.locator('#tab-button-profile').click()
                        profile_copy = page.get_by_role('button', name='Копировать ссылку', exact=True).first
                        page.evaluate("window.copyMode='pending'; window.clipboardCalls=0; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{window.clipboardCalls+=1;throw new Error('platform clipboard must not be used')}}})")
                        profile_copy.click(); page.wait_for_function('typeof window.resolveCopy===\"function\"')
                        assert page.evaluate("window.copyCalls.at(-1).text.startsWith('https://vk.com/app54723764#ref=')")
                        page.evaluate('window.resolveCopy({result:true})')
                        page.wait_for_function("!document.querySelector('body').matches('[aria-busy=true]')")
                        assert page.evaluate('window.clipboardCalls') == 0
                        assert page.locator('#shareFallback').is_hidden()

                        page.evaluate("window.shareMode='reject'; window.copyMode='pending'; delete window.resolveCopy")
                        page.get_by_role('button', name='Поделиться реферальной ссылкой', exact=True).click()
                        page.wait_for_function('typeof window.resolveCopy===\"function\"')
                        page.evaluate('window.resolveCopy({result:true})')
                        page.wait_for_function("!document.querySelector('body').matches('[aria-busy=true]')")
                        assert page.evaluate('window.clipboardCalls') == 0
                        assert page.locator('#shareFallback').is_hidden()

                        page.locator('#tab-button-support').click()
                        card = page.get_by_role('article', name='Поделиться Копилкой', exact=True)
                        button = card.get_by_role('button', name='Копировать ссылку', exact=True)
                        assert button.count()==1, 'Share support action must expose native copy rather than Open and credit'
                        start_url=page.url
                        page.evaluate('window.documentMarker={}; window.markerBefore=window.documentMarker')
                        def credited():
                            with sqlite3.connect(db_path) as db:
                                return db.execute("SELECT COUNT(*) FROM user_support_actions ua JOIN support_actions a ON a.id=ua.action_id WHERE a.slug='share-kopilka'").fetchone()[0]
                        for mode in ['false', 'reject', 'missing', 'timeout']:
                            page.evaluate('(mode)=>{window.copyMode=mode;if(mode===\"missing\"){window.savedBridge=window.vkBridge;window.vkBridge=null;}}', mode)
                            button.click()
                            page.wait_for_function("!document.querySelector('body').matches('[aria-busy=true]')")
                            assert credited()==0 and not posts, (mode, posts)
                            assert page.url==start_url and len(ctx.pages)==1
                            if mode=='missing': page.evaluate('window.vkBridge=window.savedBridge')
                        page.evaluate("window.copyMode='pending'")
                        button.click(); page.wait_for_function('typeof window.resolveCopy===\"function\"')
                        assert credited()==0 and not posts, 'No credit before bridge confirmation'
                        copied=page.evaluate('window.copyCalls.at(-1).text')
                        assert copied.startswith('https://vk.com/app54723764#ref='), copied
                        page.evaluate('window.resolveCopy({result:true})')
                        page.wait_for_function("!document.querySelector('body').matches('[aria-busy=true]')")
                        assert credited()==1 and len(posts)==1
                        assert 'Ссылка скопирована' in page.locator('#statusRegion').inner_text()
                        assert button.is_enabled(), 'Already credited share must remain usable'
                        page.evaluate('delete window.resolveCopy');button.click()
                        page.wait_for_function('typeof window.resolveCopy===\"function\"')
                        page.evaluate('window.resolveCopy({result:true})')
                        page.wait_for_function("!document.querySelector('body').matches('[aria-busy=true]')")
                        assert credited()==1 and len(posts)==1, 'Repeat copy must not request another credit'
                        assert page.url==start_url and len(ctx.pages)==1
                        assert page.evaluate('window.documentMarker===window.markerBefore')
                        assert not errors,errors
                        print('PASS native VK profile/fallback/support copy; no platform clipboard/navigation/early credit; repeat copy without duplicate reward; JS errors=0')
                    finally:
                        ctx.close();browser.close()
            finally:
                proc.terminate();proc.wait(timeout=10)


if __name__=='__main__':
    main()
