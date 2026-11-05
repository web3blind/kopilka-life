#!/usr/bin/env python3
"""7662239: trusted Today story handoff, real canvas/HTTP/temp SQLite.
Only the native Bridge is controlled. VK day-scene PNG is created in-browser;
it does not use the profile /api/story-card PNG endpoint.
Run via run-browser-qa.py with notices-outbound-deny.cjs absolute preload.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import struct
import time
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ['KOPILKA_QA_BASE_URL']
APP = Path(os.environ.get('NOTICES_QA_APP', ROOT / 'public/app.js'))
AUDIT = Path(os.environ['NOTICES_QA_AUDIT'])
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
assert os.environ['SCHEDULER_ENABLED'] == 'false'
assert 'notices-outbound-deny.cjs' in os.environ.get('NODE_OPTIONS', '')
AUDIT.mkdir(parents=True, exist_ok=True)
results = []


def snapshot():
    with sqlite3.connect('file:' + os.environ['DB_PATH'] + '?mode=ro', uri=True) as db:
        return {n: db.execute('SELECT * FROM "' + n + '" ORDER BY rowid').fetchall()
                for (n,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


BRIDGE = '''window.qaMode='success';window.qaCalls=[];window.vkBridge={supports:()=>true,subscribe:()=>{},send:async(method,params)=>{
 if(method==='VKWebAppShare')return {};
 if(method!=='VKWebAppShowStoryBox')return {result:true};
 qaCalls.push(params);
 if(qaMode==='cancel')throw {error_data:{error_reason:'User denied'}};
 if(qaMode==='error')throw Error('fixture transport error');
 if(qaMode==='false')return {result:false};
 if(qaMode==='missing')return {};
 if(qaMode==='code-data')return {code_data:'fixture-editor'};
 return {result:true};
}};'''

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    try:
        for index, lang in enumerate(('ru', 'en')):
            context = browser.new_context(viewport={'width':1100, 'height':900}, service_workers='block')
            try:
                outbound, errors = [], []
                def route(r):
                    path = urllib.parse.urlparse(r.request.url).path
                    if not r.request.url.startswith(BASE + '/'):
                        outbound.append(r.request.url); r.abort()
                    elif path.startswith('/vendor/vk-bridge'):
                        r.fulfill(content_type='application/javascript', body=BRIDGE)
                    elif path == '/app.js':
                        r.fulfill(content_type='application/javascript', body=APP.read_text())
                    else:
                        r.continue_()
                context.route('**/*', route)
                values = dict(vk_app_id='54723764', vk_user_id=str(81997662239 + index), vk_platform='mobile_android', vk_ts=str(int(time.time())))
                values['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(values.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
                query = urllib.parse.urlencode(values)
                auth = context.request.post(BASE + '/api/auth/vk', data={'launchParams':query}).json()
                headers = {'Authorization':'Bearer ' + auth['token']}
                assert context.request.post(BASE + '/api/settings/locale', headers=headers, data={'locale':lang}).ok
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                with page.expect_response(lambda r: '/assets/day-scene/tree.webp' in r.url) as source:
                    page.goto(BASE + '/?' + query)
                assert source.value.status == 200 and len(source.value.body()) > 10000
                page.wait_for_function('state.user && state.summary && !state.busy')
                page.wait_for_load_state('networkidle')
                assert page.evaluate('locale()') == lang
                before = snapshot()
                page.clock.install()
                page.clock.pause_at(page.evaluate('(Date.now() + 100) / 1000'))
                button = page.locator('#daySceneShare')
                close = page.locator('#dismissStatus')
                region = page.locator('#statusRegion')
                def text(): return region.text_content()
                def story(mode='success'):
                    page.locator('#tab-button-today').click()
                    page.evaluate('(mode)=>{qaMode=mode;qaCalls=[]}', mode)
                    button.click()
                    page.wait_for_function('qaCalls.length===1 && !document.getElementById("daySceneShare").disabled')
                    assert button.get_attribute('aria-disabled') == 'false'
                    encoded = page.evaluate('qaCalls[0].blob.split(",")[1]')
                    png = base64.b64decode(encoded)
                    assert png[:8] == bytes.fromhex('89504e470d0a1a0a') and struct.unpack('>II', png[16:24]) == (1080,1920)
                    assert page.evaluate('qaCalls[0].attachment.url') == 'https://vk.com/app54723764'
                    return hashlib.sha256(png).hexdigest()
                def check(name, fn):
                    try:
                        fn(); results.append(dict(locale=lang, name=name, passed=True))
                    except Exception:
                        import traceback
                        results.append(dict(locale=lang, name=name, passed=False, error=traceback.format_exc(), status=text(), category=page.evaluate('statusCategory')))
                    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
                def expiry():
                    png_hash = story()
                    assert text() == page.evaluate('L("daySceneStoryOpened")')
                    assert close.is_visible() and close.is_enabled(), '7662239 handoff dismissal hidden/disabled'
                    assert region.get_attribute('role') == 'status'
                    page.clock.run_for(4999); assert text()
                    page.clock.run_for(1); assert text() == ''
                    assert button.is_enabled()
                    results.append(dict(locale=lang, name='real-PNG', passed=True, sha256=png_hash))
                check('Today-handoff-visible-dismiss-exact-five-seconds', expiry)
                def explicit():
                    story('code-data'); assert close.is_visible() and close.is_enabled()
                    close.focus(); page.keyboard.press('Enter')
                    assert text() == '' and page.evaluate('document.activeElement.id') == 'daySceneShare'
                    story(); close.focus(); page.keyboard.press('Space'); assert text() == ''
                check('localized-keyboard-dismiss-focus-return-code-data-contract', explicit)
                def hide_return():
                    story(); page.locator('#tab-button-week').click()
                    page.evaluate('window.qaRegion=document.getElementById("statusRegion");Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))')
                    page.clock.run_for(5000)
                    page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:false});document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))')
                    assert text() == '' and page.evaluate('qaRegion===document.getElementById("statusRegion")')
                    page.locator('#tab-button-today').click(); assert text() == ''
                check('tab-and-retained-DOM-hide-return', hide_return)
                def revision():
                    story(); page.clock.run_for(3000)
                    old_revision = page.evaluate('statusRevision')
                    story(); page.evaluate('window.qaOldClose=document.getElementById("dismissStatus").onclick;true')
                    assert page.evaluate('statusRevision') > old_revision
                    assert text() == page.evaluate('L("daySceneStoryOpened")')
                    page.clock.run_for(2000); assert text() == page.evaluate('L("daySceneStoryOpened")')
                    page.evaluate('setStatus("New auth warning","error");qaOldClose()')
                    page.clock.run_for(6000); assert text() == 'New auth warning' and close.is_hidden()
                    story(); page.evaluate('setVerifiedUser({...state.user,id:state.user.id+10000});setStatus("Other identity warning","error")')
                    page.clock.run_for(5000); assert text() == 'Other identity warning'
                check('newer-notice-revision-and-identity-warning-fences', revision)
                def contrasts():
                    for mode in ('cancel', 'error', 'false', 'missing'):
                        story(mode); saved = text()
                        assert saved
                        if mode == 'cancel':
                            assert saved == page.evaluate('L("daySceneStoryCanceled")') and not region.evaluate('(e)=>e.classList.contains("error")')
                            page.clock.run_for(5000); assert text() == ''
                        else:
                            assert region.evaluate('(e)=>e.classList.contains("error")') and close.is_hidden()
                            page.clock.run_for(6000); assert text() == saved
                    page.locator('#tab-button-profile').click()
                    page.locator('#shareRefLink').focus(); page.keyboard.press('Enter')
                    page.wait_for_function('statusCategory==="share-unconfirmed"')
                    saved = text(); page.clock.run_for(6000)
                    assert text() == saved and page.locator('#shareFallback').is_visible()
                    assert page.locator('#shareFallbackLink').input_value()
                check('cancel-errors-false-missing-and-unconfirmed-manual-fallback-distinct', contrasts)
                check('SQLite-all-tables-unchanged', lambda: (_ for _ in ()).throw(AssertionError('DB changed')) if snapshot() != before else None)
                assert not errors, errors
                assert all(u == 'https://telegram.org/js/telegram-web-app.js' for u in outbound), outbound
            finally:
                context.close()
    finally:
        browser.close()
        report = dict(app_sha256=hashlib.sha256(APP.read_bytes()).hexdigest(), results=results,
                      passed=sum(r['passed'] for r in results), failed=sum(not r['passed'] for r in results), scope='Local Chromium, controlled Bridge, no VK publication or physical-device proof')
        (AUDIT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
assert all(r['passed'] for r in results), report
print('DAY_SCENE_NOTICE_PASS', len(results))
